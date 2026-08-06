const Users = require('./model');

async function parseWithAI(text) {
    console.log(`[DEBUG] [parseWithAI] Parsing text: "${text}"`);
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
        console.error("[DEBUG] [parseWithAI] GROQ_API_KEY is missing in .env");
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
        console.log("[DEBUG] [parseWithAI] Sending request to Groq API (llama-3.3-70b-versatile)...");
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

        console.log(`[DEBUG] [parseWithAI] Groq API HTTP Status: ${response.status} ${response.statusText}`);
        const data = await response.json();
        console.log("[DEBUG] [parseWithAI] Groq API Response Payload:", JSON.stringify(data, null, 2));

        if (data.error) {
            console.error("[DEBUG] [parseWithAI] GROQ API ERROR:", JSON.stringify(data.error, null, 2));
            return null;
        }

        let outputText = data.choices?.[0]?.message?.content;
        if (!outputText) {
            console.log("[DEBUG] [parseWithAI] GROQ RESPONSE (Empty Content):", JSON.stringify(data, null, 2));
            return null;
        }

        try {
            const parsed = JSON.parse(outputText);
            console.log("[DEBUG] [parseWithAI] Successfully parsed JSON:", parsed);
            return parsed;
        } catch (err) {
            console.error("[DEBUG] [parseWithAI] Groq returned invalid JSON string:", outputText, err);
            return null;
        }
    } catch (err) {
        console.error("[DEBUG] [parseWithAI] Groq API request exception:", err);
        return null;
    }
}

async function sendMessageToTelegram(chatId, text) {
    console.log(`[DEBUG] [sendMessageToTelegram] Attempting to send message to chatId ${chatId}: "${text}"`);
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
        console.error("[DEBUG] [sendMessageToTelegram] TELEGRAM_BOT_TOKEN is missing in .env");
        return;
    }
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    try {
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text: text })
        });
        const resData = await response.json();
        console.log(`[DEBUG] [sendMessageToTelegram] Telegram API HTTP Status: ${response.status} ${response.statusText}`, resData);
    } catch (err) {
        console.error("[DEBUG] [sendMessageToTelegram] Error sending Telegram message:", err);
    }
}

async function sendChatAction(chatId, action = 'typing') {
    console.log(`[DEBUG] [sendChatAction] Attempting to send chat action "${action}" to chatId ${chatId}`);
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
        console.error("[DEBUG] [sendChatAction] TELEGRAM_BOT_TOKEN is missing in .env");
        return;
    }
    const url = `https://api.telegram.org/bot${botToken}/sendChatAction`;
    try {
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, action: action })
        });
        const resData = await response.json();
        console.log(`[DEBUG] [sendChatAction] Telegram API HTTP Status: ${response.status} ${response.statusText}`, resData);
    } catch (err) {
        console.error("[DEBUG] [sendChatAction] Error sending Telegram chat action:", err);
    }
}

/**
 * Main handler for Telegram updates.
 * @param {Object} message - The message object from Telegram update.
 * @param {Function} saveTransactionFn - Reference to the saveTransaction function from server.js.
 */
async function handleUpdate(message, saveTransactionFn) {
    console.log("[DEBUG] [handleUpdate] Incoming update message object:", JSON.stringify(message, null, 2));
    const text = message?.text;
    const chatId = message?.chat?.id;

    if (!text || !chatId) {
        console.log("[DEBUG] [handleUpdate] Skipped processing: Missing text or chatId.");
        return;
    }

    // 1. Handle Commands
    if (text.startsWith('/link ')) {
        const code = text.split(' ')[1]?.toUpperCase();
        console.log(`[DEBUG] [handleUpdate] Processing /link command with code "${code}" for chatId ${chatId}`);
        if (!code) {
            return sendMessageToTelegram(chatId, "Please provide the 5-letter code. Format: /link ABCDE");
        }

        try {
            console.log(`[DEBUG] [handleUpdate] Searching MongoDB for user with telegramLinkingCode "${code}"`);
            const user = await Users.findOne({
                telegramLinkingCode: code,
                telegramLinkingCodeExpires: { $gt: new Date() }
            });

            if (!user) {
                console.log(`[DEBUG] [handleUpdate] Invalid or expired linking code "${code}" for chatId ${chatId}`);
                return sendMessageToTelegram(chatId, "❌ Invalid or expired code. Please generate a new one from the dashboard Profile page.");
            }

            console.log(`[DEBUG] [handleUpdate] Linking code valid. Linking chatId ${chatId} to user ${user.userId || user._id}`);
            user.telegramId = chatId.toString();
            user.telegramLinkingCode = null;
            user.telegramLinkingCodeExpires = null;
            await user.save();
            console.log(`[DEBUG] [handleUpdate] User ${user.userId || user._id} linked successfully.`);

            return sendMessageToTelegram(chatId, "✅ Account linked successfully! You can now send your expenses here (e.g., 'Coffee 5' or 'Fuel 50 yesterday').");
        } catch (err) {
            console.error("[DEBUG] [handleUpdate] Linking error:", err);
            return sendMessageToTelegram(chatId, "⚠️ An error occurred during linking. Please try again later.");
        }
    }

    // 2. Handle Expenses
    try {
        console.log(`[DEBUG] [handleUpdate] Querying user record by telegramId "${chatId}"`);
        const user = await Users.findOne({ telegramId: chatId.toString() });
        if (!user) {
            console.log(`[DEBUG] [handleUpdate] Account not linked for telegramId "${chatId}"`);
            return sendMessageToTelegram(chatId, "🔌 Your account is not linked. Please go to the Profile page in the Spend Insight dashboard to generate a linking code.");
        }
        console.log(`[DEBUG] [handleUpdate] Found linked user ${user.userId || user._id}`);

        // Show "typing..." immediately
        await sendChatAction(chatId, 'typing');

        console.log(`[DEBUG] [handleUpdate] Parsing expense text with Groq AI: "${text}"`);
        const result = await parseWithAI(text);
        console.log("[DEBUG] [handleUpdate] AI Parsing Result:", result);

        if (result && result.amount) {
            try {
                console.log(`[DEBUG] [handleUpdate] Saving transaction to database for user ${user.userId}...`);
                await saveTransactionFn(user.userId, result);
                console.log(`[DEBUG] [handleUpdate] Transaction saved successfully.`);
                return sendMessageToTelegram(chatId, `✅ Added: $${result.amount.toLocaleString()} for ${result.notes || result.label || result.category} [${result.category}] on ${result.date}`);
            } catch (saveErr) {
                console.error("[DEBUG] [handleUpdate] Error saving transaction from Telegram:", saveErr);
                return sendMessageToTelegram(chatId, "❌ Failed to save the transaction to your account. Please try again.");
            }
        } else {
            console.log("[DEBUG] [handleUpdate] Unable to extract valid expense details/amount from result.");
            return sendMessageToTelegram(chatId, "🤔 Sorry, I couldn't understand that expense structure. Try: 'uber 200 today' or 'coffee 5.5'");
        }
    } catch (err) {
        console.error("[DEBUG] [handleUpdate] Telegram handling error:", err);
        return sendMessageToTelegram(chatId, "⚠️ Oops! Something went wrong while processing your request. Please try again later.");
    }
}

module.exports = {
    handleUpdate
};
