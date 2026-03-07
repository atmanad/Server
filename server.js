const express = require('express');
const app = express();
const sql = require('mssql');
const cors = require('cors');
const mongoose = require('mongoose');
const Users = require('./model');
const bodyParser = require('body-parser');
require('dotenv').config();
const { MONGODB_URI } = process.env

// Parse JSON bodies
app.use(bodyParser.json());

const allowedOrigins = [
  'https://spend-insight.netlify.app',
  'https://192.168.137.1:3000',
  "https://localhost:3000"
];

const corsOptions = {
  origin: (origin, callback) => {
    // Check if the request origin is in the allowedOrigins array
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
};

app.use(cors(corsOptions));
app.use(express.json());

// Connect to MongoDB
mongoose
  .connect(MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    dbName: 'si-db'
  })
  .then(() => {
    console.log('Connected to MongoDB');
  })
  .catch((error) => {
    console.error('Error connecting to MongoDB:', error);
  });

const dateStringToMonthYear = (dateString) => {
  const dateObject = new Date(dateString);

  return {
    month: dateObject.getMonth() + 1,
    year: dateObject.getFullYear()
  }
}

async function saveTransaction(userId, transaction) {
  const tDate = new Date(transaction.date);
  const month = tDate.getMonth() + 1;
  const year = tDate.getFullYear();

  let user = await Users.findOne({ userId: userId });

  if (!user) {
    user = new Users({
      userId: userId,
      balance: 0,
      expenses: [],
      categories: [{ categoryName: 'Food' }, { categoryName: "Travel" }],
      labels: []
    });
  }

  let expense = user.expenses.find((exp) => exp.year === year && exp.month === month);

  if (!expense) {
    expense = {
      year: year,
      month: month,
      transactions: [],
      savings: 0,
      income: []
    };
    user.expenses.push(expense);
    // Find the newly pushed expense to work with the reference
    expense = user.expenses[user.expenses.length - 1];
  }

  expense.transactions.push(transaction);
  expense.savings -= Number(transaction.amount);
  user.balance -= Number(transaction.amount);

  await user.save();
  return user;
}

async function parseWithAI(text) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error("GROQ_API_KEY is missing in .env");
    return null;
  }

  const prompt = `
Extract expense details from this text: "${text}"

Current Date: ${new Date().toISOString().split('T')[0]}

Return ONLY valid JSON in this format:
{
  "amount": number,
  "category": string,
  "label": string,
  "date": "YYYY-MM-DD",
  "notes": string
}

Rules:
- amount: numerical value
- category: one of [Food, Travel, Entertainment, Shopping, Health, Bills, Others]
- label: home/personal
- date: extract date or relative date (e.g., "yesterday", "last friday"). If missing, use today's date.
- notes: any additional information about the transaction
`;

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [
          {
            role: "system",
            content: "You are a helpful assistant that extracts expense details. You must respond ONLY with the JSON object."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        response_format: { type: "json_object" },
        temperature: 0.1
      }),
    });

    const data = await response.json();

    if (data.error) {
      console.error("GROQ API ERROR:", JSON.stringify(data.error, null, 2));
      return null;
    }

    let outputText = data.choices?.[0]?.message?.content;
    if (!outputText) {
      console.log("GROQ RESPONSE (Empty):", JSON.stringify(data, null, 2));
      return null;
    }

    try {
      return JSON.parse(outputText);
    } catch (err) {
      console.error("Groq returned invalid JSON:", outputText);
      return null;
    }
  } catch (err) {
    console.error("Groq parsing error:", err);
    return null;
  }
}


async function sendMessageToTelegram(chatId, text) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.error("TELEGRAM_BOT_TOKEN is missing in .env");
    return;
  }
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: text })
    });
  } catch (err) {
    console.error("Error sending Telegram message:", err);
  }
}

app.post('/api/v1/telegram', async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method not allowed" });
  }

  const message = req.body?.message;
  const text = message?.text;
  const chatId = message?.chat?.id;

  // ✅ Immediately respond to Telegram
  res.status(200).json({ status: "received" });

  if (!text || !chatId) return;

  // 1. Handle Commands
  if (text.startsWith('/link ')) {
    const code = text.split(' ')[1]?.toUpperCase();
    if (!code) {
      return sendMessageToTelegram(chatId, "Please provide the 5-letter code. Format: /link ABCDE");
    }

    try {
      const user = await Users.findOne({
        telegramLinkingCode: code,
        telegramLinkingCodeExpires: { $gt: new Date() }
      });

      if (!user) {
        return sendMessageToTelegram(chatId, "Invalid or expired code. Please generate a new one from the dashboard.");
      }

      user.telegramId = chatId.toString();
      user.telegramLinkingCode = null; // Clear code after use
      user.telegramLinkingCodeExpires = null;
      await user.save();

      return sendMessageToTelegram(chatId, "Account linked successfully! You can now send your expenses here.");
    } catch (err) {
      console.error("Linking error:", err);
      return sendMessageToTelegram(chatId, "An error occurred during linking. Please try again later.");
    }
  }

  // 2. Handle Expenses
  try {
    const user = await Users.findOne({ telegramId: chatId.toString() });
    if (!user) {
      return sendMessageToTelegram(chatId, "Your account is not linked. Please go to the dashboard to connect to Telegram.");
    }

    const result = await parseWithAI(text);
    console.log("AI RESULT:", result);

    if (result && result.amount) {
      await saveTransaction(user.userId, result);
      return sendMessageToTelegram(chatId, `Added: ${result.amount} for ${result.notes || result.label} (${result.category}) on ${result.date}`);
    } else {
      return sendMessageToTelegram(chatId, "Sorry, I couldn't understand that expense. Try: 'uber 200 today' or 'coffee 5.5'");
    }
  } catch (err) {
    console.error("Telegram webhook error:", err);
  }
})

// ============================================ Transaction API =============================================================== //

// Fetch all Transactions
app.get('/api/v1/transactions', async (req, res) => {
  try {
    const { userId, selectedMonth } = req.query;
    console.log("userId", userId, "month", selectedMonth);
    monthObject = new Date(selectedMonth);
    const month = monthObject.getUTCMonth() + 1;
    const year = monthObject.getFullYear();

    console.log(month, year);

    const user = await Users.findOne({ userId: userId });
    if (!user) {
      user = new Users({
        userId: userId,
        balance: 0,
        expenses: [],
        categories: [{ categoryName: 'Food' }, { categoryName: "Travel" }],
        labels: []
      });
      await user.save();
      return res.json({ transactions: [], savings: 0, incomes: [], balance: 0 })
    }

    let expense = user.expenses.find((exp) => exp.year === year && exp.month === month);
    if (!expense) {
      return res.json({ transactions: [], savings: 0, incomes: [], balance: user.balance })
    }

    res.json({ transactions: expense.transactions, savings: expense.savings, incomes: expense.income, balance: user.balance });
  } catch (error) {
    console.error('Error fetching transactions:', error);
    res.sendStatus(500);
  }
});


// Endpoint to insert a transaction
app.post('/api/v1/transactions', async (req, res) => {
  try {
    const { userId, transaction } = req.body;
    await saveTransaction(userId, transaction);
    res.sendStatus(200);
  } catch (error) {
    console.error('Error inserting transaction:', error);
    res.sendStatus(500);
  }
});

//Delete a transaction
app.delete('/api/v1/transactions', async (req, res) => {
  try {
    const { userId, transactionId, date } = req.query;
    const { month, year } = dateStringToMonthYear(date);
    const user = await Users.findOne({ userId: userId });
    const expense = user.expenses.find(exp => exp.year === year && exp.month === month);

    if (!expense) {
      return res.status(404).json({ error: 'Expense not found' });
    }
    const transactionIndex = expense.transactions.findIndex((trans) => trans._id.toString() === transactionId);
    if (transactionIndex === -1) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    // Add the amount to savings & total balance
    expense.savings += expense.transactions[transactionIndex].amount;
    user.balance += expense.transactions[transactionIndex].amount;

    // Remove the transaction from the transactions array
    expense.transactions.splice(transactionIndex, 1);

    // Save the updated user data
    await user.save();

    res.sendStatus(200);
  } catch (error) {
    console.error('Error deleting Transaction:', error);
    res.sendStatus(500);
  }
});

// ============================================ Category API =============================================================== //
// Fetch all categories
app.get('/api/v1/categories/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    let user = await Users.findOne({ userId: userId });
    if (!user) {
      user = new Users({
        userId: userId,
        balance: 0,
        expenses: [],
        categories: [{ categoryName: 'Food' }, { categoryName: "Travel" }],
        labels: []
      });
      await user.save();
      return res.json([]);
    }
    res.json(user.categories);
  } catch (error) {
    console.error('Error fetching categories:', error);
    res.sendStatus(500);
  }
});

// Insert a category
app.post('/api/v1/categories', async (req, res) => {
  try {
    const { userId, categoryName } = req.body;

    let user = await Users.findOne({ userId: userId });
    if (!user) {
      user = new Users({
        userId: userId,
        balance: 0,
        expenses: [],
        categories: [],
        labels: []
      });
    }
    const categoryExists = user.categories.some(category => category.categoryName === categoryName);
    if (categoryExists) {
      return res.status(409).json({ error: 'Category alreay exists' });
    }

    user.categories.push({ categoryName: categoryName });
    await user.save();
    res.sendStatus(200);
  } catch (error) {
    console.error('Error inserting category:', error);
    res.sendStatus(500);
  }
});

// Delete a category
app.delete('/api/v1/categories/:userId/:categoryId', async (req, res) => {
  try {
    const { userId, categoryId } = req.params;
    let user = await Users.findOne({ userId: userId });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const indexToDelete = user.categories.findIndex(obj => obj._id.toString() === categoryId);
    if (indexToDelete === -1) return res.status(404).json({ error: 'Category not found' });

    user.categories.splice(indexToDelete, 1);
    await user.save();
    res.sendStatus(200);
  } catch (error) {
    console.error('Error deleting category:', error);
    res.sendStatus(500);
  }
});

// ============================================ Label API =============================================================== //
// Fetch all labels
app.get('/api/v1/labels/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await Users.findOne({ userId: userId });
    if (!user) {
      return res.json([]);
    }
    res.json(user.labels);
  } catch (error) {
    console.error('Error fetching labels:', error);
    res.sendStatus(500);
  }
});

// Insert a label
app.post('/api/v1/labels', async (req, res) => {
  try {
    const { userId, labelName } = req.body;

    let user = await Users.findOne({ userId: userId });
    if (!user) {
      user = new Users({
        userId: userId,
        balance: 0,
        expenses: [],
        categories: [],
        labels: []
      });
    }
    const labelExists = user.labels.some(label => label.labelName === labelName);
    if (labelExists) {
      return res.status(409).json({ error: 'Label alreay exists' });
    }

    user.labels.push({ labelName: labelName });
    await user.save();
    res.sendStatus(200);
  } catch (error) {
    console.error('Error inserting label:', error);
    res.sendStatus(500);
  }
});

// Delete a label
app.delete('/api/v1/labels/:userId/:labelId', async (req, res) => {
  try {
    const { userId, labelId } = req.params;
    let user = await Users.findOne({ userId: userId });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const indexToDelete = user.labels.findIndex(obj => obj._id.toString() === labelId);
    if (indexToDelete === -1) return res.status(404).json({ error: 'Label not found' });

    user.labels.splice(indexToDelete, 1);
    await user.save();
    res.sendStatus(200);
  } catch (error) {
    console.error('Error deleting label:', error);
    res.sendStatus(500);
  }
});

// ============================================ Income API =============================================================== //
// Insert an income
app.post('/api/v1/income', async (req, res) => {
  try {
    const { userId, income } = req.body;
    const { month, year } = dateStringToMonthYear(income.date);

    let user = await Users.findOne({ userId: userId });
    if (!user) {
      user = new Users({
        userId: userId,
        balance: 0,
        expenses: [],
        categories: [],
        labels: []
      });
    }
    // Find the expense for the given year and month within the user
    let expense = user.expenses.find((exp) => exp.year === year && exp.month === month);
    console.log(expense);

    // If expense not found, create a new expense for the given year and month
    if (!expense) {
      expense = {
        year: year,
        month: month,
        transactions: [],
        savings: Number(income.amount),
        income: [income]
      };
      user.expenses.push(expense);
    } else {
      expense.income.push(income);
      expense.savings += Number(income.amount);
    }

    // Add the amount to monthly savings & total balance
    user.balance += Number(income.amount);

    await user.save();
    res.sendStatus(200);
  } catch (error) {
    console.error('Error inserting label:', error);
    res.sendStatus(500);
  }
});

// Fetch income for a specific month and year
app.get('/api/v1/income', async (req, res) => {
  try {
    const { userId, date } = req.query;
    const { month, year } = dateStringToMonthYear(date);

    const user = await Users.findOne({ userId: userId });
    if (!user) {
      return res.json({ income: [], savings: 0, balance: 0 });
    }

    const expense = user.expenses.find((exp) => exp.year === Number(year) && exp.month === Number(month));
    if (!expense) {
      return res.json({ income: [], savings: 0, balance: 0 });
    }

    res.json({ income: expense.income, savings: expense.savings, balance: user.balance });
  } catch (error) {
    console.error('Error fetching income:', error);
    res.sendStatus(500);
  }
});

// Delete an income
app.delete('/api/v1/income', async (req, res) => {
  try {
    const { userId, incomeId, date } = req.query;
    const { month, year } = dateStringToMonthYear(date);
    const user = await Users.findOne({ userId: userId });
    const expense = user.expenses.find(exp => exp.year === year && exp.month === month);

    if (!expense) {
      return res.status(404).json({ error: 'Expense not found' });
    }
    const incomeIndex = expense.income.findIndex((inc) => inc._id.toString() === incomeId);
    if (incomeIndex === -1) {
      return res.status(404).json({ error: 'Income not found' });
    }

    // Remove the amount from savings & total balance
    expense.savings -= expense.income[incomeIndex].amount;
    user.balance -= expense.income[incomeIndex].amount;

    // Remove the transaction from the transactions array
    expense.income.splice(incomeIndex, 1);

    // Save the updated user data
    await user.save();

    res.sendStatus(200);
  } catch (error) {
    console.error('Error deleting Income:', error);
    res.sendStatus(500);
  }
});


// Manage Expence and Balance
app.get('/api/v1/user', async (req, res) => {
  try {
    console.log(req.query);
    const { userId } = req.query;
    console.log(userId);
    fetch(`https://spend-insight.us.auth0.com/api/v2/users/${encodeURIComponent(userId)}`)
      .then(response => {
        console.log(response);
        return response.json();
      })
      .then(data => console.log(data))
      .catch(error => console.log(error));

  } catch (error) {
    console.error('Error fetching MonthlySummary:', error);
    res.sendStatus(500);
  }
});

// Generate a 5-letter linking code for Telegram
app.get('/api/v1/user/linking-code', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    const code = Math.random().toString(36).substring(2, 7).toUpperCase();
    const expires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes from now

    let user = await Users.findOne({ userId: userId });
    if (!user) {
      user = new Users({
        userId: userId,
        balance: 0,
        expenses: [],
        categories: [{ categoryName: 'Food' }, { categoryName: "Travel" }],
        labels: []
      });
    }

    user.telegramLinkingCode = code;
    user.telegramLinkingCodeExpires = expires;
    await user.save();

    res.json({ code });
  } catch (error) {
    console.error('Error generating linking code:', error);
    res.sendStatus(500);
  }
});

const port = process.env.PORT || 3001;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

module.exports = app;