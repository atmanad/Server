const express = require('express');
const app = express();
const sql = require('mssql');
const config = require('./config');
const cors = require('cors');
const mongoose = require('mongoose');
const Users = require('./model');
const bodyParser = require('body-parser');

// Parse JSON bodies
app.use(bodyParser.json());

app.use(cors());
app.use(express.json());

// Connect to MongoDB
mongoose
  .connect(config.mongodb.uri, {
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


// ============================================ Transaction API =============================================================== //

// Fetch all Transactions
app.get('/api/v1/transactions', async (req, res) => {
  try {
    const { userId, selectedMonth } = req.query;
    console.log("userId", userId, "month", selectedMonth);
    monthObject = new Date(selectedMonth);
    const month = monthObject.getMonth() + 1;
    const year = monthObject.getFullYear();

    console.log(month, year);

    const user = await Users.findOne({ userId: userId });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    let expense = user.expenses.find((exp) => exp.year === year && exp.month === month);
    if (!expense) {
      return res.status(404).json({ error: 'No spending history found' });
    }
    res.json(expense.transactions);
  } catch (error) {
    console.error('Error fetching transactions:', error);
    res.sendStatus(500);
  }
});

// Fetch transactions by month
app.get('/api/v1/transactions/month/:startDate/:endDate', async (req, res) => {
  try {
    const { startDate, endDate } = req.params;

    // Create a new SQL connection pool
    const pool = await sql.connect(config);

    // Fetch all transactions from the 'Transactions' table
    const result = await pool.request()
      .input('firstDayOfMonth', sql.Date, startDate)
      .input('lastDayOfMonth', sql.Date, endDate)
      .query('SELECT * FROM Transactions WHERE Date >= @firstDayOfMonth AND Date <= @lastDayOfMonth ORDER BY Date DESC');

    // Send the fetched transactions as the response
    res.json(result.recordset);
  } catch (error) {
    console.error('Error fetching transactions:', error);
    res.sendStatus(500);
  }
});


// Endpoint to insert a transaction
app.post('/api/v1/transactions', async (req, res) => {
  try {
    const { userId, transaction } = req.body;
    const tDate = new Date(transaction.date);
    const month = tDate.getMonth() + 1;
    const year = tDate.getFullYear();

    // Find the user by ID
    let user = await Users.findOne({ userId: userId });

    console.log("line 95", user);

    // If user not found, create a new user document
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

    // If expense not found, create a new expense for the given year and month
    if (!expense) {
      expense = {
        year: year,
        month: month,
        transactions: [],
        savings: 0,
        income: []
      };
      user.expenses.push(expense);
    }

    // Add the transaction to the expense
    expense.transactions.push(transaction);

    // Save the updated user document
    await user.save();

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
    console.log(req.query);
    console.log(date);
    const { month, year } = dateStringToMonthYear(date);
    console.log(month, year);
    const user = await Users.findOne({ userId: userId });
    console.log(user);
    const expense = user.expenses.find(exp => exp.year === year && exp.month === month);

    if (!expense) {
      return res.status(404).json({ error: 'Expense not found' });
    }
    console.log(expense);
    const transactionIndex = expense.transactions.findIndex((trans) => trans._id.toString() === transactionId);
    if (transactionIndex === -1) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

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
    const user = await Users.findOne({ userId: userId });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
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
    console.log(req.body);

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
      return res.status(404).json({ error: 'User not found' });
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
    console.log(user);

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
        savings: 0,
        income: [income]
      };
      user.expenses.push(expense);
    }else{
      expense.income.push(income);
    }

    await user.save();
    res.sendStatus(200);
  } catch (error) {
    console.error('Error inserting label:', error);
    res.sendStatus(500);
  }
});

// Fetch income
// Fetch income for a specific month and year
app.get('/api/v1/income', async (req, res) => {
  try {
    const { userId, date } = req.query;
    const {month, year} = dateStringToMonthYear(date);

    const user = await Users.findOne({ userId: userId });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const expense = user.expenses.find((exp) => exp.year === Number(year) && exp.month === Number(month));
    if (!expense) {
      return res.status(404).json({ error: 'Expense not found' });
    }

    res.json(expense.income);
  } catch (error) {
    console.error('Error fetching income:', error);
    res.sendStatus(500);
  }
});


// Manage Expence and Balance
// app.get('/api/v1/expenses/:year/:month', async (req, res) => {
//   try {
//     const { year, month } = req.params;

//     // Create a new SQL connection pool
//     const pool = await sql.connect(config);

//     // Fetch all transactions from the 'Transactions' table
//     console.log("Fething transactions for", year, " ", month);
//     const result = await pool.request()
//       .input('year', sql.Int, year)
//       .input('month', sql.Int, month)
//       .query('SELECT * FROM MonthlySummary WHERE Year = @year AND Month = @month');

//     // Send the fetched expenses as the response
//     res.json(result.recordset);
//   } catch (error) {
//     console.error('Error fetching MonthlySummary:', error);
//     res.sendStatus(500);
//   }
// });

// app.post('/api/v1/expenses', async (req, res) => {
//   try {
//     const { Year, Month, Balance, Income, Expenses } = req.body;
//     // console.log("Data", req.body);
//     // Create a new SQL connection pool
//     const pool = await sql.connect(config);
//     const checkQuery = `SELECT * FROM MonthlySummary WHERE Month = ${Month} AND Year = ${Year}`;
//     const checkResult = await pool.request().query(checkQuery);

//     if (checkResult.recordset.length > 0) {
//       console.log("updating monthly summary", req.body);
//       const updateQuery = `UPDATE MonthlySummary SET Balance = ${Balance}, Income = ${Income}, Expenses = ${Expenses} WHERE Month = ${Month} AND Year = ${Year}`;
//       await pool.request().query(updateQuery);
//     } else {
//       //the record doesn't exist, insert a new record
//       console.log("inserting monthly summary", req.body);
//       const insertQuery = `INSERT INTO MonthlySummary (Month, Year, Balance, Income, Expenses) VALUES (${Month}, ${Year}, ${Balance}, ${Income}, ${Expenses})`;
//       await pool.request().query(insertQuery);
//     }

//     res.sendStatus(200);
//   } catch (error) {
//     console.error('Error inserting Monthly Summary:', error);
//     res.sendStatus(500);
//   }
// });


const port = process.env.PORT || 3001;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
