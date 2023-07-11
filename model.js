const mongoose = require('mongoose');

// Define the schema for the transactions
const transactionSchema = new mongoose.Schema({
    amount: { type: Number, required: true },
    category: { type: String, required: true },
    label: { type: String, required: true },
    notes: { type: String },
    date: { type: Date, required: true }
});

// Define the schema for the expenses
const expenseSchema = new mongoose.Schema({
    year: { type: Number, required: true },
    month: { type: Number, required: true },
    transactions: [transactionSchema],
    savings: { type: Number, required: true },
    income: { type: Number, required: true }
});

// Define the schema for the users collection
const usersSchema = new mongoose.Schema({
    userId: { type: String, required: true },
    balance: { type: Number, required: true },
    expenses: [expenseSchema],
    categories: { type: [{categoryName: String}], default: [] },
    labels: {type: [{labelName: String}], default: [] },
});


// Create the Users model
const Users = mongoose.model('users', usersSchema);

module.exports = Users;
