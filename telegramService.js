const Users = require('./model');

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
- category: one of [Food, Travel, Entertainment, Shopping, Health, Bills, Others, Home, Personal, BBS, Recharge, D, S]
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

async function sendChatAction(chatId, action = 'typing') {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
        console.error("TELEGRAM_BOT_TOKEN is missing in .env");
        return;
    }
    const url = `https://api.telegram.org/bot${botToken}/sendChatAction`;
    try {
        await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, action: action })
        });
    } catch (err) {
        console.error("Error sending Telegram chat action:", err);
    }
}

/**
 * Main handler for Telegram updates.
 * @param {Object} message - The message object from Telegram update.
 * @param {Function} saveTransactionFn - Reference to the saveTransaction function from server.js.
 */
async function handleUpdate(message, saveTransactionFn) {
    const text = message?.text;
    const chatId = message?.chat?.id;

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
                return sendMessageToTelegram(chatId, "❌ Invalid or expired code. Please generate a new one from the dashboard Profile page.");
            }

            user.telegramId = chatId.toString();
            user.telegramLinkingCode = null;
            user.telegramLinkingCodeExpires = null;
            await user.save();

            return sendMessageToTelegram(chatId, "✅ Account linked successfully! You can now send your expenses here (e.g., 'Coffee 5' or 'Fuel 50 yesterday').");
        } catch (err) {
            console.error("Linking error:", err);
            return sendMessageToTelegram(chatId, "⚠️ An error occurred during linking. Please try again later.");
        }
    }

    // 2. Handle Expenses
    try {
        const user = await Users.findOne({ telegramId: chatId.toString() });
        if (!user) {
            return sendMessageToTelegram(chatId, "🔌 Your account is not linked. Please go to the Profile page in the Spend Insight dashboard to generate a linking code.");
        }

        // Show "typing..." immediately
        await sendChatAction(chatId, 'typing');

        const result = await parseWithAI(text);
        console.log("AI RESULT:", result);

        if (result && result.amount) {
            try {
                await saveTransactionFn(user.userId, result);
                return sendMessageToTelegram(chatId, `✅ Added: $${result.amount.toLocaleString()} for ${result.notes || result.label || result.category} [${result.category}] on ${result.date}`);
            } catch (saveErr) {
                console.error("Error saving transaction from Telegram:", saveErr);
                return sendMessageToTelegram(chatId, "❌ Failed to save the transaction to your account. Please try again.");
            }
        } else {
            return sendMessageToTelegram(chatId, "🤔 Sorry, I couldn't understand that expense structure. Try: 'uber 200 today' or 'coffee 5.5'");
        }
    } catch (err) {
        console.error("Telegram handling error:", err);
        return sendMessageToTelegram(chatId, "⚠️ Oops! Something went wrong while processing your request. Please try again later.");
    }
}

module.exports = {
    handleUpdate
};
