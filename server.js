/**
 * @module server
 * @description SpendInsight Express server – handles transactions, categories, labels, income, and Telegram integration.
 */
const express = require('express');
const app = express();
const sql = require('mssql');
const cors = require('cors');
const mongoose = require('mongoose');
const Users = require('./model');
const bodyParser = require('body-parser');
require('dotenv').config();
const { MONGODB_URI } = process.env;
const telegramService = require('./telegramService');
const categoryLearningEngine = require('./categoryLearningEngine');

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

// Connect to MongoDB (Serverless friendly)
let isConnected = false;
/**
 * Connect to MongoDB in a serverless-friendly way (idempotent).
 * @async
 * @function connectDB
 */
async function connectDB() {
  if (isConnected || mongoose.connection.readyState === 1) {
    isConnected = true;
    return;
  }
  try {
    console.log('[DEBUG] Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI, {
      dbName: 'si-db'
    });
    isConnected = true;
    console.log('[DEBUG] Connected to MongoDB');
  } catch (error) {
    console.error('[DEBUG] Error connecting to MongoDB:', error);
  }
}

// Middleware to ensure DB connection for serverless environment
app.use(async (req, res, next) => {
  await connectDB();
  next();
});

/**
 * @function healthCheck
 * @name GET /health
 * @description Health check endpoint to keep the server and MongoDB connection active.
 *              Performs a lightweight MongoDB query to prevent database archiving.
 * @returns {Object} 200 - `{ status: 'ok', database: 'connected', timestamp: string }`
 * @returns {Object} 500 - `{ status: 'error', database: 'disconnected', error: string }`
 */
app.get(['/health', '/api/health', '/api/v1/health'], async (req, res) => {
  try {
    // Perform a lightweight MongoDB query to ensure DB stays active and avoids archiving
    await Users.findOne({}).select('_id').lean();
    res.status(200).json({
      status: 'ok',
      database: 'connected',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[DEBUG] Health check database query failed:', error);
    res.status(500).json({
      status: 'error',
      database: 'disconnected',
      error: error.message
    });
  }
});

/**
 * Parse a date string into month and year components.
 * @function dateStringToMonthYear
 * @param {string} dateString - A date string parseable by `new Date()`.
 * @returns {{month: number, year: number}} The 1-indexed month and full year.
 */
const dateStringToMonthYear = (dateString) => {
  const dateObject = new Date(dateString);

  return {
    month: dateObject.getMonth() + 1,
    year: dateObject.getFullYear()
  }
}

/**
 * Save one or more transactions for a user, handling category learning, user creation, and balance/savings adjustments.
 * @async
 * @function saveTransaction
 * @param {string} userId - The unique identifier of the user.
 * @param {Object|Object[]} transactionOrTransactions - A single transaction object or an array of transaction objects.
 * @returns {Promise<Object>} The saved user document.
 */
async function saveTransaction(userId, transactionOrTransactions) {
  const transactions = Array.isArray(transactionOrTransactions)
    ? transactionOrTransactions
    : [transactionOrTransactions];

  let user = await Users.findOne({ userId: userId });

  if (!user) {
    user = new Users({
      userId: userId,
      balance: 0,
      expenses: [],
      categories: [
        { categoryName: 'Food' },
        { categoryName: 'Travel' },
        { categoryName: 'Entertainment' },
        { categoryName: 'Shopping' },
        { categoryName: 'Others' }
      ],
      labels: []
    });
  }

  if (!user.categories || user.categories.length === 0) {
    user.categories = [
      { categoryName: 'Food' },
      { categoryName: 'Travel' },
      { categoryName: 'Entertainment' },
      { categoryName: 'Shopping' },
      { categoryName: 'Others' }
    ];
  }

  for (const transaction of transactions) {
    if (!transaction || (typeof transaction.amount !== 'number' && isNaN(Number(transaction.amount)))) {
      continue;
    }

    const normKeywords = categoryLearningEngine.normalizeKeywords(transaction.keywords || []);

    let selectedCatObj = null;
    let learningStatus = {
      categoryId: null,
      categoryConfidence: 1.0,
      categorySource: 'keyword_match'
    };

    if (transaction.category && transaction.category.trim() !== '') {
      const catName = transaction.category.trim();
      let matchCat = user.categories.find(c => (c.categoryName || c.name || '').toLowerCase() === catName.toLowerCase());
      if (!matchCat) {
        user.categories.push({ categoryName: catName, keywords: [] });
        matchCat = user.categories[user.categories.length - 1];
      }
      selectedCatObj = matchCat;
      const isCorrection = Boolean(transaction.isUserCorrection);
      learningStatus = {
        categoryId: matchCat._id ? matchCat._id.toString() : null,
        categoryConfidence: 1.0,
        categorySource: isCorrection ? 'user_corrected' : 'manual_entry'
      };

      if (normKeywords.length > 0) {
        categoryLearningEngine.updateCategoryKeywords(
          selectedCatObj,
          normKeywords,
          learningStatus.categorySource,
          1.0,
          isCorrection
        );
      }
    } else {
      const classification = await categoryLearningEngine.selectCategory(
        user.categories,
        normKeywords,
        telegramService.classifyCategoryWithFallbackAI
      );

      transaction.category = classification.selectedCategoryName;

      let matchCat = user.categories.find(c =>
        (c.categoryName || c.name || '').toLowerCase() === classification.selectedCategoryName.toLowerCase()
      );
      if (!matchCat) {
        user.categories.push({ categoryName: classification.selectedCategoryName, keywords: [] });
        matchCat = user.categories[user.categories.length - 1];
      }
      selectedCatObj = matchCat;

      learningStatus = {
        categoryId: classification.selectedCategoryId || (matchCat._id ? matchCat._id.toString() : null),
        categoryConfidence: classification.confidence,
        categorySource: classification.source
      };

      if (normKeywords.length > 0) {
        categoryLearningEngine.updateCategoryKeywords(
          selectedCatObj,
          normKeywords,
          classification.source,
          classification.confidence,
          false
        );
      }
    }

    transaction.keywords = normKeywords;
    transaction.learningStatus = learningStatus;

    const tDate = new Date(transaction.date || new Date().toISOString().split('T')[0]);
    const month = tDate.getMonth() + 1;
    const year = tDate.getFullYear();

    let expense = user.expenses.find((exp) => exp.year === year && exp.month === month);

    if (!expense) {
      user.expenses.push({
        year: year,
        month: month,
        transactions: [],
        savings: 0,
        income: []
      });
      expense = user.expenses[user.expenses.length - 1];
    }

    expense.transactions.push(transaction);
    expense.savings -= Number(transaction.amount);
    user.balance -= Number(transaction.amount);
  }

  await user.save();
  return user;
}


// --- Telegram helper functions moved to telegramService.js ---

/**
 * @function telegramWebhook
 * @name POST /api/v1/telegram
 * @description Webhook endpoint for incoming Telegram bot updates.
 *              Processes incoming messages and delegates to the Telegram service handler.
 * @param {Object} req.body - The Telegram webhook payload.
 * @param {Object} req.body.message - The Telegram message object.
 * @returns {Object} 200 - `{ status: 'received' }`
 */
app.post('/api/v1/telegram', async (req, res) => {
  console.log("[DEBUG] [/api/v1/telegram] Webhook received:", JSON.stringify(req.body, null, 2));
  const message = req.body?.message;

  if (message) {
    try {
      // Must await handleUpdate in serverless environments (e.g., Vercel)
      // so the process doesn't freeze after res.json() is called.
      await telegramService.handleUpdate(message, saveTransaction);
    } catch (err) {
      console.error("[DEBUG] [/api/v1/telegram] Error in Telegram processing:", err);
    }
  }

  res.status(200).json({ status: "received" });
});

// ============================================ Transaction API =============================================================== //

/**
 * @function getTransactions
 * @name GET /api/v1/transactions
 * @description Fetch all transactions for a user in a given month.
 *              Creates a new user with default categories if one does not exist.
 * @param {string} req.query.userId - The unique identifier of the user.
 * @param {string} req.query.selectedMonth - The target month as a date string (parsed to extract month/year).
 * @returns {Object} 200 - `{ transactions: Array, savings: number, incomes: Array, balance: number }`
 * @returns {void} 500 - Internal server error.
 */
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


/**
 * @function createTransaction
 * @name POST /api/v1/transactions
 * @description Insert a new transaction for a user. Delegates to the saveTransaction
 *              helper which handles category learning, balance/savings adjustments, and user creation.
 * @param {Object} req.body - The request body.
 * @param {string} req.body.userId - The unique identifier of the user.
 * @param {Object} req.body.transaction - The transaction object to insert.
 * @param {number} req.body.transaction.amount - The transaction amount.
 * @param {string} [req.body.transaction.category] - Optional category name.
 * @param {string} [req.body.transaction.date] - Optional date string (defaults to today).
 * @param {string[]} [req.body.transaction.keywords] - Optional keywords for category learning.
 * @returns {void} 200 - Success.
 * @returns {void} 500 - Internal server error.
 */
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

/**
 * @function updateTransaction
 * @name PUT /api/v1/transactions
 * @description Update an existing transaction. If the category is changed, triggers
 *              category learning with the updated keywords and marks the source as 'user_corrected'.
 *              Also adjusts balance and savings if the amount is modified.
 * @param {Object} req.body - The request body.
 * @param {string} req.body.userId - The unique identifier of the user.
 * @param {string} req.body.transactionId - The MongoDB _id of the transaction to update.
 * @param {Object} [req.body.updatedTransaction] - The updated transaction fields (alternative key).
 * @param {Object} [req.body.transaction] - The updated transaction fields (alternative key).
 * @param {string} [req.body.date] - Optional date override to locate the correct expense period.
 * @returns {Object} 200 - `{ status: 'updated', transaction: Object }`
 * @returns {Object} 400 - `{ error: string }` - Missing required fields.
 * @returns {Object} 404 - `{ error: string }` - User, expense, or transaction not found.
 * @returns {void} 500 - Internal server error.
 */
app.put('/api/v1/transactions', async (req, res) => {
  try {
    const { userId, transactionId, updatedTransaction, transaction: txObject, date } = req.body;
    const targetTx = updatedTransaction || txObject;

    if (!userId || !transactionId || !targetTx) {
      return res.status(400).json({ error: 'userId, transactionId, and transaction (or updatedTransaction) are required' });
    }

    const user = await Users.findOne({ userId: userId });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const tDate = date || targetTx.date || new Date().toISOString();
    const { month, year } = dateStringToMonthYear(tDate);
    const expense = user.expenses.find(exp => exp.year === year && exp.month === month);

    if (!expense) {
      return res.status(404).json({ error: 'Expense not found' });
    }

    const transaction = expense.transactions.find((trans) => trans._id.toString() === transactionId);
    if (!transaction) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    // Adjust balance & savings if amount changed
    if (typeof targetTx.amount === 'number' && !isNaN(targetTx.amount)) {
      const diff = targetTx.amount - transaction.amount;
      expense.savings -= diff;
      user.balance -= diff;
      transaction.amount = targetTx.amount;
    }

    if (targetTx.label !== undefined) transaction.label = targetTx.label;
    if (targetTx.notes !== undefined) transaction.notes = targetTx.notes;
    if (targetTx.date) transaction.date = new Date(targetTx.date);

    // If category was changed/corrected by user
    if (targetTx.category && targetTx.category.trim() !== '' && targetTx.category.trim().toLowerCase() !== (transaction.category || '').toLowerCase()) {
      const newCategoryName = targetTx.category.trim();
      transaction.category = newCategoryName;

      let matchCat = user.categories.find(c => (c.categoryName || c.name || '').toLowerCase() === newCategoryName.toLowerCase());
      if (!matchCat) {
        user.categories.push({ categoryName: newCategoryName, keywords: [] });
        matchCat = user.categories[user.categories.length - 1];
      }

      const keywordsToLearn = categoryLearningEngine.normalizeKeywords(
        (targetTx.keywords && targetTx.keywords.length > 0)
          ? targetTx.keywords
          : (transaction.keywords || [])
      );

      if (keywordsToLearn.length > 0) {
        categoryLearningEngine.updateCategoryKeywords(
          matchCat,
          keywordsToLearn,
          'user_corrected',
          1.0,
          true
        );
      }

      transaction.keywords = keywordsToLearn;
      transaction.learningStatus = {
        categoryId: matchCat._id ? matchCat._id.toString() : null,
        categoryConfidence: 1.0,
        categorySource: 'user_corrected'
      };
    }

    await user.save();
    res.status(200).json({ status: 'updated', transaction });
  } catch (error) {
    console.error('Error updating transaction:', error);
    res.sendStatus(500);
  }
});

/**
 * @function deleteTransaction
 * @name DELETE /api/v1/transactions
 * @description Delete a transaction by its ID. Restores the transaction amount to the
 *              user's monthly savings and total balance.
 * @param {string} req.query.userId - The unique identifier of the user.
 * @param {string} req.query.transactionId - The MongoDB _id of the transaction to delete.
 * @param {string} req.query.date - The date string used to locate the correct expense period.
 * @returns {void} 200 - Success.
 * @returns {Object} 404 - `{ error: string }` - Expense or transaction not found.
 * @returns {void} 500 - Internal server error.
 */
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
/**
 * @function getCategories
 * @name GET /api/v1/categories/:userId
 * @description Fetch all categories for a user. Creates a new user with default
 *              categories ('Food', 'Travel') if the user does not exist.
 * @param {string} req.params.userId - The unique identifier of the user.
 * @returns {Array<Object>} 200 - Array of category objects.
 * @returns {void} 500 - Internal server error.
 */
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

/**
 * @function createCategory
 * @name POST /api/v1/categories
 * @description Add a new category for a user. Returns 409 if the category already exists.
 *              Creates a new user if one does not exist.
 * @param {Object} req.body - The request body.
 * @param {string} req.body.userId - The unique identifier of the user.
 * @param {string} req.body.categoryName - The name of the category to add.
 * @returns {void} 200 - Success.
 * @returns {Object} 409 - `{ error: 'Category already exists' }`
 * @returns {void} 500 - Internal server error.
 */
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

/**
 * @function deleteCategory
 * @name DELETE /api/v1/categories/:userId/:categoryId
 * @description Delete a category by its ID for a given user.
 * @param {string} req.params.userId - The unique identifier of the user.
 * @param {string} req.params.categoryId - The MongoDB _id of the category to delete.
 * @returns {void} 200 - Success.
 * @returns {Object} 404 - `{ error: string }` - User or category not found.
 * @returns {void} 500 - Internal server error.
 */
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
/**
 * @function getLabels
 * @name GET /api/v1/labels/:userId
 * @description Fetch all labels for a user. Returns an empty array if the user does not exist.
 * @param {string} req.params.userId - The unique identifier of the user.
 * @returns {Array<Object>} 200 - Array of label objects.
 * @returns {void} 500 - Internal server error.
 */
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

/**
 * @function createLabel
 * @name POST /api/v1/labels
 * @description Add a new label for a user. Returns 409 if the label already exists.
 *              Creates a new user if one does not exist.
 * @param {Object} req.body - The request body.
 * @param {string} req.body.userId - The unique identifier of the user.
 * @param {string} req.body.labelName - The name of the label to add.
 * @returns {void} 200 - Success.
 * @returns {Object} 409 - `{ error: 'Label already exists' }`
 * @returns {void} 500 - Internal server error.
 */
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

/**
 * @function deleteLabel
 * @name DELETE /api/v1/labels/:userId/:labelId
 * @description Delete a label by its ID for a given user.
 * @param {string} req.params.userId - The unique identifier of the user.
 * @param {string} req.params.labelId - The MongoDB _id of the label to delete.
 * @returns {void} 200 - Success.
 * @returns {Object} 404 - `{ error: string }` - User or label not found.
 * @returns {void} 500 - Internal server error.
 */
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
/**
 * @function createIncome
 * @name POST /api/v1/income
 * @description Add a new income entry for a user in the month derived from the income date.
 *              Creates a new user and/or expense period if they do not exist.
 *              Updates monthly savings and total balance accordingly.
 * @param {Object} req.body - The request body.
 * @param {string} req.body.userId - The unique identifier of the user.
 * @param {Object} req.body.income - The income object to insert.
 * @param {number} req.body.income.amount - The income amount.
 * @param {string} req.body.income.date - The date of the income (used to derive month/year).
 * @returns {void} 200 - Success.
 * @returns {void} 500 - Internal server error.
 */
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

/**
 * @function getIncome
 * @name GET /api/v1/income
 * @description Fetch income entries, savings, and balance for a user in a specific month.
 * @param {string} req.query.userId - The unique identifier of the user.
 * @param {string} req.query.date - A date string used to derive the target month and year.
 * @returns {Object} 200 - `{ income: Array, savings: number, balance: number }`
 * @returns {void} 500 - Internal server error.
 */
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

/**
 * @function deleteIncome
 * @name DELETE /api/v1/income
 * @description Delete an income entry by its ID. Subtracts the income amount from
 *              the user's monthly savings and total balance.
 * @param {string} req.query.userId - The unique identifier of the user.
 * @param {string} req.query.incomeId - The MongoDB _id of the income entry to delete.
 * @param {string} req.query.date - A date string used to derive the target month and year.
 * @returns {void} 200 - Success.
 * @returns {Object} 404 - `{ error: string }` - Expense or income not found.
 * @returns {void} 500 - Internal server error.
 */
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


/**
 * @function getUser
 * @name GET /api/v1/user
 * @description Fetch user profile information from Auth0 by userId.
 *              Retrieves user data from the Auth0 Management API.
 * @param {string} req.query.userId - The Auth0 user identifier.
 * @returns {void} 500 - Internal server error.
 */
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

/**
 * @function getLinkingCode
 * @name GET /api/v1/user/linking-code
 * @description Generate a 5-character alphanumeric linking code for Telegram account linking.
 *              The code expires after 10 minutes. Creates a new user if one does not exist.
 * @param {string} req.query.userId - The unique identifier of the user.
 * @returns {Object} 200 - `{ code: string }`
 * @returns {Object} 400 - `{ error: 'userId is required' }`
 * @returns {void} 500 - Internal server error.
 */
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