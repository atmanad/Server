const mongoose = require('mongoose');

// Schema for category keywords
const keywordSchema = new mongoose.Schema({
    word: { type: String, required: true },
    weight: { type: Number, default: 1 }
}, { _id: false });

// Schema for user categories
const categorySchema = new mongoose.Schema({
    categoryName: { type: String, required: true },
    keywords: { type: [keywordSchema], default: [] }
});

// Define the schema for the transactions
const transactionSchema = new mongoose.Schema({
    amount: { type: Number, required: true },
    category: { type: String, required: true },
    label: { type: String },
    notes: { type: String },
    date: { type: Date, required: true },
    keywords: { type: [String], default: [] },
    learningStatus: {
        categoryId: { type: String },
        categoryConfidence: { type: Number },
        categorySource: { type: String } // 'keyword_match' | 'category_name_match' | 'fallback_ai' | 'user_corrected'
    }
});

// Define the schema for the expenses
const expenseSchema = new mongoose.Schema({
    year: { type: Number, required: true },
    month: { type: Number, required: true },
    transactions: [transactionSchema],
    savings: { type: Number, required: true },
    income: { type: [{ amount: Number, date: Date, category: String, notes: String }], default: [] }
});

// Define the schema for the users collection
const usersSchema = new mongoose.Schema({
    userId: { type: String, required: true },
    balance: { type: Number, required: true },
    expenses: [expenseSchema],
    categories: { type: [categorySchema], default: [] },
    labels: { type: [{ labelName: String }], default: [] },
    telegramId: { type: String },
    telegramLinkingCode: { type: String },
    telegramLinkingCodeExpires: { type: Date },
});


// Create the Users model
const Users = mongoose.model('users', usersSchema);

module.exports = Users;
