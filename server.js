const express = require('express');
const app = express();
const sql = require('mssql');
const config = require('./config');
const cors = require('cors');
app.use(cors());
app.use(express.json());
sql.connect(config)
  .then(() => {
    console.log('Connected to Azure SQL Database');
  })
  .catch((err) => {
    console.error('Error connecting to Azure SQL Database:', err);
  });

// Define routes here
// Fetch all Transactions
app.get('/api/v1/transactions', async (req, res) => {
  try {
    // Create a new SQL connection pool
    const pool = await sql.connect(config);

    // Fetch all transactions from the 'Transactions' table
    const result = await pool.request().query('SELECT * FROM Transactions');

    // Send the fetched transactions as the response
    res.json(result.recordset);
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
    console.log(req.body);
    const { category, date, amount, notes } = req.body;

    // Create a new SQL connection pool
    const pool = await sql.connect(config);

    // Insert the transaction into the 'Transactions' table
    await pool.request()
      .input('category', sql.VarChar(255), category)
      .input('date', sql.Date, date)
      .input('amount', sql.Decimal(10, 2), amount)
      .input('notes', sql.VarChar(255), notes)
      .query('INSERT INTO Transactions (Category, Date, Amount, Notes) VALUES (@category, @date, @amount, @notes)');

    res.sendStatus(200);
  } catch (error) {
    console.error('Error inserting transaction:', error);
    res.sendStatus(500);
  }
});

//Delete a transaction
app.delete('/api/v1/transactions/:transactionId', async (req, res) => {
  try {
    console.log(req.params);
    const { transactionId } = req.params;
    const pool = await sql.connect(config);
    await pool.request().input('transactionId', sql.Int, transactionId).query('DELETE FROM Transactions WHERE ID = @transactionId');
    res.sendStatus(200);
  } catch (error) {
    console.error('Error deleting Transaction:', error);
    res.sendStatus(500);
  }
});

// Fetch all categories
app.get('/api/v1/categories', async (req, res) => {
  try {
    const pool = await sql.connect(config);
    const result = await pool.request().query('SELECT * FROM Categories');
    res.json(result.recordset);
  } catch (error) {
    console.error('Error fetching categories:', error);
    res.sendStatus(500);
  }
});

// Insert a category
app.post('/api/v1/categories', async (req, res) => {
  try {
    console.log(req.body);
    const { categoryName } = req.body;
    const pool = await sql.connect(config);
    await pool.request().input('categoryName', sql.VarChar(255), categoryName).query('INSERT INTO Categories (CategoryName) VALUES (@categoryName)');
    res.sendStatus(200);
  } catch (error) {
    console.error('Error inserting category:', error);
    res.sendStatus(500);
  }
});

// Delete a category
app.delete('/api/v1/categories/:categoryId', async (req, res) => {
  try {
    console.log(req.params);
    const { categoryId } = req.params;
    const pool = await sql.connect(config);
    await pool.request().input('categoryId', sql.Int, categoryId).query('DELETE FROM Categories WHERE CategoryID = @categoryId');
    res.sendStatus(200);
  } catch (error) {
    console.error('Error deleting category:', error);
    res.sendStatus(500);
  }
});

// Fetch all labels
app.get('/api/v1/labels', async (req, res) => {
  try {
    const pool = await sql.connect(config);
    const result = await pool.request().query('SELECT * FROM Labels');
    res.json(result.recordset);
  } catch (error) {
    console.error('Error fetching labels:', error);
    res.sendStatus(500);
  }
});

// Insert a label
app.post('/api/v1/labels', async (req, res) => {
  try {
    const { labelName } = req.body;
    const pool = await sql.connect(config);
    await pool
      .request()
      .input('labelName', sql.VarChar(255), labelName)
      .query('INSERT INTO Labels (LabelName) VALUES (@labelName)');
    res.sendStatus(200);
  } catch (error) {
    console.error('Error inserting label:', error);
    res.sendStatus(500);
  }
});

// Delete a label
app.delete('/api/v1/labels/:labelId', async (req, res) => {
  try {
    const { labelId } = req.params;
    const pool = await sql.connect(config);
    await pool
      .request()
      .input('labelId', sql.Int, labelId)
      .query('DELETE FROM Labels WHERE LabelID = @labelId');
    res.sendStatus(200);
  } catch (error) {
    console.error('Error deleting label:', error);
    res.sendStatus(500);
  }
});


// Manage Expence and Balance
app.get('/api/v1/expenses/:year/:month', async (req, res) => {
  try {
    const { year, month } = req.params;

    // Create a new SQL connection pool
    const pool = await sql.connect(config);

    // Fetch all transactions from the 'Transactions' table
    console.log("Fething transactions for", year," ", month);
    const result = await pool.request()
      .input('year', sql.Int, year)
      .input('month', sql.Int, month)
      .query('SELECT * FROM MonthlySummary WHERE Year = @year AND Month = @month');

    // Send the fetched expenses as the response
    res.json(result.recordset);
  } catch (error) {
    console.error('Error fetching MonthlySummary:', error);
    res.sendStatus(500);
  }
});

app.post('/api/v1/expenses', async (req, res) => {
  try {
    const { Year, Month, Balance, Income, Expenses } = req.body;
    // console.log("Data", req.body);
    // Create a new SQL connection pool
    const pool = await sql.connect(config);
    const checkQuery = `SELECT * FROM MonthlySummary WHERE Month = ${Month} AND Year = ${Year}`;
    const checkResult = await pool.request().query(checkQuery);

    if(checkResult.recordset.length > 0){
      console.log("updating monthly summary", req.body);
      const updateQuery = `UPDATE MonthlySummary SET Balance = ${Balance}, Income = ${Income}, Expenses = ${Expenses} WHERE Month = ${Month} AND Year = ${Year}`;
      await pool.request().query(updateQuery);
    }else{
      //the record doesn't exist, insert a new record
      console.log("inserting monthly summary", req.body);
      const insertQuery = `INSERT INTO MonthlySummary (Month, Year, Balance, Income, Expenses) VALUES (${Month}, ${Year}, ${Balance}, ${Income}, ${Expenses})`;
      await pool.request().query(insertQuery);
    }
    
    res.sendStatus(200);
  } catch (error) {
    console.error('Error inserting Monthly Summary:', error);
    res.sendStatus(500);
  }
});


const port = process.env.PORT || 3001;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
