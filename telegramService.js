const Users = require('./model');
const categoryLearningEngine = require('./categoryLearningEngine');

/**
 * Fetch image file from Telegram Bot API and convert to Base64 Data URL.
 * @param {string} fileId 
 * @returns {Promise<string|null>}
 */
async function getTelegramImageBase64(fileId) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
        console.error("[DEBUG] [getTelegramImageBase64] TELEGRAM_BOT_TOKEN is missing in .env");
        return null;
    }

    try {
        console.log(`[DEBUG] [getTelegramImageBase64] Getting file path for fileId: ${fileId}`);
        const getFileUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`;
        const fileRes = await fetch(getFileUrl);
        const fileData = await fileRes.json();

        if (!fileData.ok || !fileData.result?.file_path) {
            console.error("[DEBUG] [getTelegramImageBase64] Telegram getFile failed:", fileData);
            return null;
        }

        const filePath = fileData.result.file_path;
        console.log(`[DEBUG] [getTelegramImageBase64] File path obtained: ${filePath}. Downloading file...`);

        const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
        const imgRes = await fetch(downloadUrl);
        const arrayBuffer = await imgRes.arrayBuffer();

        const base64 = Buffer.from(arrayBuffer).toString('base64');
        const ext = filePath.split('.').pop()?.toLowerCase();
        let mimeType = 'image/jpeg';
        if (ext === 'png') mimeType = 'image/png';
        if (ext === 'webp') mimeType = 'image/webp';

        return `data:${mimeType};base64,${base64}`;
    } catch (err) {
        console.error("[DEBUG] [getTelegramImageBase64] Exception during image download/conversion:", err);
        return null;
    }
}

/**
 * Helper to ensure parsed result always returns an array of valid expense objects.
 */
/**
 * Helper to ensure parsed result always returns an array of valid expense objects.
 */
function normalizeExpenses(parsed) {
    if (!parsed) return [];

    let list = [];
    if (Array.isArray(parsed)) {
        list = parsed;
    } else if (Array.isArray(parsed.expenses)) {
        list = parsed.expenses;
    } else if (parsed.amount) {
        list = [parsed];
    }

    return list.filter(item => item && (typeof item.amount === 'number' || !isNaN(Number(item.amount))) && Number(item.amount) > 0)
        .map(item => ({
            amount: Number(item.amount),
            category: item.category || '',
            label: item.label || 'personal',
            date: item.date,
            notes: item.notes || item.description || '',
            keywords: Array.isArray(item.keywords) ? item.keywords : []
        }));
}

/**
 * Parse text input with Groq AI to extract expenses and generic nature keywords.
 * @param {string} text 
 * @param {Array<Object>} [categories] - User's categories with keywords for context
 * @param {Function} [normalizeKeywordsFn] - normalizeKeywords function from categoryLearningEngine
 * @returns {Promise<Array>}
 */
async function parseWithAI(text, categories, normalizeKeywordsFn) {
    console.log(`[DEBUG] [parseWithAI] Parsing text: "${text}"`);
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
        console.error("[DEBUG] [parseWithAI] GROQ_API_KEY is missing in .env");
        return [];
    }

    // Build category context for LLM
    let categoryContext = '';
    if (Array.isArray(categories) && categories.length > 0) {
        const categoriesWithKeywords = categories.map(cat => {
            const keywords = Array.isArray(cat.keywords) ? cat.keywords : [];
            // Sort by weight and take top 5
            const topKeywords = keywords
                .sort((a, b) => b.weight - a.weight)
                .slice(0, 5)
                .map(k => k.word)
                .join(', ');
            return {
                category: cat.categoryName || cat.name,
                topKeywords: topKeywords
            };
        });
        categoryContext = `\n\nUser's available categories and learned keywords:\n${JSON.stringify(categoriesWithKeywords, null, 2)}`;
    }

    const prompt = `
Extract expense details from this text: "${text}"${categoryContext}

Current Date: ${new Date().toISOString().split('T')[0]}

Return ONLY valid JSON in this format:
{
  "expenses": [
    {
      "amount": number,
      "date": "YYYY-MM-DD",
      "notes": string,
      "label": string,
      "category": string,
      "keywords": [string]
    }
  ]
}

Rules:
- amount: numerical value
- label: home/personal
- date: extract date or relative date (e.g., "yesterday", "last friday"). If missing, use today's date.
- notes: short description of transaction
- category: MUST be exactly one of the user's provided categories (case-sensitive match). Do NOT create, rename, or modify categories.
- keywords: Provide up to 3 short keywords describing the nature of the expense.
- Use the user's categories and learned keywords as context when determining the category.
- Prefer the category whose learned keywords and meaning best match the expense.
- Do NOT include merchant names as keywords.
- Exclude amounts, dates, currency, and generic words like "expense" or "payment" as keywords.
- Extract all separate expenses if text mentions multiple items.
`;

    console.log(`[DEBUG] [parseWithAI] Groq API prompt: ${categoryContext}`);

    try {
        console.log("[DEBUG] [parseWithAI] Sending request to Groq API (llama-3.3-70b-versatile)...");
        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "meta-llama/llama-prompt-guard-2-86m",
                messages: [
                    {
                        role: "system",
                        content: "You are a helpful assistant that extracts expense details and generic expense nature keywords into structured JSON."
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
            return [];
        }

        let outputText = data.choices?.[0]?.message?.content;
        if (!outputText) {
            console.log("[DEBUG] [parseWithAI] GROQ RESPONSE (Empty Content):", JSON.stringify(data, null, 2));
            return [];
        }

        try {
            const parsed = JSON.parse(outputText);
            console.log("[DEBUG] [parseWithAI] Successfully parsed JSON:", parsed);
            
            // Normalize keywords for each expense
            const normalizedExpenses = normalizeExpenses(parsed).map(expense => {
                // If category was provided by LLM and we have normalizeKeywords function, use it
                const normKeywords = normalizeKeywordsFn 
                    ? normalizeKeywordsFn(expense.keywords || [])
                    : (expense.keywords ? Array.isArray(expense.keywords) ? expense.keywords : [expense.keywords] : []);
                
                return {
                    ...expense,
                    keywords: normKeywords
                };
            });
            
            console.log("[DEBUG] [parseWithAI] Normalized expenses:", normalizedExpenses);
            return normalizedExpenses;
        } catch (err) {
            console.error("[DEBUG] [parseWithAI] Groq returned invalid JSON string:", outputText, err);
            return [];
        }
    } catch (err) {
        console.error("[DEBUG] [parseWithAI] Groq API request exception:", err);
        return [];
    }
}

/**
 * Parse image input with Groq Vision API (qwen/qwen3.6-27b) to extract expense items.
 * @param {string} base64ImageUrl 
 * @param {string} [captionText] 
 * @param {Array<Object>} [categories] - User's categories with keywords for context
 * @param {Function} [normalizeKeywordsFn] - normalizeKeywords function from categoryLearningEngine
 * @returns {Promise<Array>}
 */
async function parseImageWithAI(base64ImageUrl, captionText, categories, normalizeKeywordsFn) {
    console.log(`[DEBUG] [parseImageWithAI] Parsing image with Groq Vision API (qwen/qwen3.6-27b)...`);
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
        console.error("[DEBUG] [parseImageWithAI] GROQ_API_KEY is missing in .env");
        return [];
    }

    // Build category context for LLM
    let categoryContext = '';
    if (Array.isArray(categories) && categories.length > 0) {
        const categoriesWithKeywords = categories.map(cat => {
            const keywords = Array.isArray(cat.keywords) ? cat.keywords : [];
            // Sort by weight and take top 5
            const topKeywords = keywords
                .sort((a, b) => b.weight - a.weight)
                .slice(0, 5)
                .map(k => k.word)
                .join(', ');
            return {
                category: cat.categoryName || cat.name,
                topKeywords: topKeywords
            };
        });
        categoryContext = `\n\nUser's available categories and learned keywords:\n${JSON.stringify(categoriesWithKeywords, null, 2)}`;
    }

    const systemPrompt = `Extract all expense details from this image/receipt.${categoryContext}

Return ONLY valid JSON in this format:
{
  "expenses": [
    {
      "amount": number,
      "date": "YYYY-MM-DD",
      "notes": string,
      "label": string,
      "category": string,
      "keywords": [string]
    }
  ]
}

Rules:
- amount: numerical value (must be > 0)
- label: home/personal
- date: extract transaction date or relative date. If missing on receipt/image, use today's date (${new Date().toISOString().split('T')[0]}).
- notes: item description or line item details.
- category: MUST be exactly one of the user's provided categories (case-sensitive match). Do NOT create, rename, or modify categories.
- keywords: Provide up to 3 short keywords describing the nature of the expense.
- Use the user's categories and learned keywords as context when determining the category.
- Prefer the category whose learned keywords and meaning best match the expense.
- Do NOT include merchant or store names as keywords.
- Exclude amounts, dates, currency, and generic words like "expense" or "payment" as keywords.
- Extract all separate expense items if it's an itemized receipt or list of expenses.`;

    try {
        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "qwen/qwen3.6-27b",
                messages: [
                    {
                        role: "system",
                        content: systemPrompt
                    },
                    {
                        role: "user",
                        content: [
                            {
                                type: "text",
                                text: captionText || "extract expense details in json format"
                            },
                            {
                                type: "image_url",
                                image_url: {
                                    url: base64ImageUrl
                                }
                            }
                        ]
                    }
                ],
                temperature: 0.6,
                max_completion_tokens: 2048,
                response_format: { "type": "json_object" },
                top_p: 0.95
            }),
        });

        console.log(`[DEBUG] [parseImageWithAI] Groq API HTTP Status: ${response.status} ${response.statusText}`);
        const data = await response.json();
        console.log("[DEBUG] [parseImageWithAI] Groq API Response Payload:", JSON.stringify(data, null, 2));

        if (data.error) {
            console.error("[DEBUG] [parseImageWithAI] GROQ API ERROR:", JSON.stringify(data.error, null, 2));
            return [];
        }

        let outputText = data.choices?.[0]?.message?.content;
        if (!outputText) {
            console.log("[DEBUG] [parseImageWithAI] GROQ RESPONSE (Empty Content):", JSON.stringify(data, null, 2));
            return [];
        }

        let cleanText = outputText.trim();
        if (cleanText.startsWith("```")) {
            cleanText = cleanText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
        }

        try {
            const parsed = JSON.parse(cleanText);
            console.log("[DEBUG] [parseImageWithAI] Successfully parsed JSON:", parsed);
            
            // Normalize keywords for each expense
            const normalizedExpenses = normalizeExpenses(parsed).map(expense => {
                // If category was provided by LLM and we have normalizeKeywords function, use it
                const normKeywords = normalizeKeywordsFn 
                    ? normalizeKeywordsFn(expense.keywords || [])
                    : (expense.keywords ? Array.isArray(expense.keywords) ? expense.keywords : [expense.keywords] : []);
                
                return {
                    ...expense,
                    keywords: normKeywords
                };
            });
            
            console.log("[DEBUG] [parseImageWithAI] Normalized expenses:", normalizedExpenses);
            return normalizedExpenses;
        } catch (err) {
            console.error("[DEBUG] [parseImageWithAI] Groq returned invalid JSON string:", outputText, err);
            return [];
        }
    } catch (err) {
        console.error("[DEBUG] [parseImageWithAI] Groq API request exception:", err);
        return [];
    }
}

/**
 * Secondary Groq AI call for ambiguous category matching or initial user seeding.
 * @param {Array<string>} keywords 
 * @param {Array<string>} availableCategories 
 * @returns {Promise<string|null>}
 */
async function classifyCategoryWithFallbackAI(keywords, availableCategories) {
    console.log(`[DEBUG] [classifyCategoryWithFallbackAI] Keywords: [${keywords.join(', ')}], Available categories: [${availableCategories.join(', ')}]`);
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey || !Array.isArray(keywords) || keywords.length === 0 || !Array.isArray(availableCategories) || availableCategories.length === 0) {
        return null;
    }

    const prompt = `
Expense keywords: ${keywords.join(', ')}
Available categories: ${availableCategories.join(', ')}

Rules:
- Select the SINGLE best fitting category from the "Available categories" list for these expense keywords.
- Do NOT create a new category name. You MUST pick one from the provided list.
- Return ONLY valid JSON in this format: {"category": "CategoryName"}
`;

    try {
        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "meta-llama/llama-prompt-guard-2-86m",
                messages: [
                    { role: "system", content: "You are a precise categorization assistant." },
                    { role: "user", content: prompt }
                ],
                response_format: { type: "json_object" },
                temperature: 0.1
            })
        });

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content;
        if (content) {
            const parsed = JSON.parse(content);
            if (parsed.category) {
                console.log(`[DEBUG] [classifyCategoryWithFallbackAI] Selected category: ${parsed.category}`);
                return parsed.category;
            }
        }
        return null;
    } catch (err) {
        console.error("[DEBUG] [classifyCategoryWithFallbackAI] Error:", err);
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
    const text = message?.text || message?.caption || '';
    const chatId = message?.chat?.id;
    const photos = message?.photo;
    const document = message?.document;

    if (!chatId) {
        console.log("[DEBUG] [handleUpdate] Skipped processing: Missing chatId.");
        return;
    }

    // Determine if message contains image file
    const isImageDocument = document && document.mime_type && document.mime_type.startsWith('image/');
    const hasPhoto = (Array.isArray(photos) && photos.length > 0) || isImageDocument;

    if (!text && !hasPhoto) {
        console.log("[DEBUG] [handleUpdate] Skipped processing: Neither text nor image received.");
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

            return sendMessageToTelegram(chatId, "✅ Account linked successfully! You can now send your expenses here as text (e.g., 'Coffee 5') or send receipt photos!");
        } catch (err) {
            console.error("[DEBUG] [handleUpdate] Linking error:", err);
            return sendMessageToTelegram(chatId, "⚠️ An error occurred during linking. Please try again later.");
        }
    }

    // 2. Handle Expenses (Text or Image)
    try {
        console.log(`[DEBUG] [handleUpdate] Querying user record by telegramId "${chatId}"`);
        const user = await Users.findOne({ telegramId: chatId.toString() });
        if (!user) {
            console.log(`[DEBUG] [handleUpdate] Account not linked for telegramId "${chatId}"`);
            return sendMessageToTelegram(chatId, "🔌 Your account is not linked. Please go to the Profile page in the Spend Insight dashboard to generate a linking code.");
        }
        console.log(`[DEBUG] [handleUpdate] Found linked user ${user.userId || user._id}`);

        let parsedExpenses = [];

        if (hasPhoto) {
            await sendChatAction(chatId, 'upload_photo');
            const fileId = isImageDocument ? document.file_id : photos[photos.length - 1].file_id;
            console.log(`[DEBUG] [handleUpdate] Processing photo update with fileId "${fileId}"...`);

            const base64Image = await getTelegramImageBase64(fileId);
            if (!base64Image) {
                return sendMessageToTelegram(chatId, "⚠️ Failed to download the photo from Telegram. Please try sending it again.");
            }

            parsedExpenses = await parseImageWithAI(base64Image, text, user.categories, categoryLearningEngine.normalizeKeywords);
        } else {
            await sendChatAction(chatId, 'typing');
            console.log(`[DEBUG] [handleUpdate] Parsing expense text with Groq AI: "${text}"`);
            parsedExpenses = await parseWithAI(text, user.categories, categoryLearningEngine.normalizeKeywords);
        }

        console.log("[DEBUG] [handleUpdate] Final parsed expenses array:", parsedExpenses);

        if (parsedExpenses && parsedExpenses.length > 0) {
            try {
                console.log(`[DEBUG] [handleUpdate] Saving ${parsedExpenses.length} transaction(s) to database for user ${user.userId}...`);
                await saveTransactionFn(user.userId, parsedExpenses);
                console.log(`[DEBUG] [handleUpdate] Transaction(s) saved successfully.`);

                const totalAmount = parsedExpenses.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);

                let responseMsg = `✅ Added ${parsedExpenses.length} transaction${parsedExpenses.length > 1 ? 's' : ''} (Total: $${totalAmount.toLocaleString()}):\n`;
                parsedExpenses.forEach((item, index) => {
                    responseMsg += `\n${index + 1}. $${Number(item.amount).toLocaleString()} - ${item.notes || item.label || item.category} [${item.category}] on ${item.date}`;
                });

                return sendMessageToTelegram(chatId, responseMsg);
            } catch (saveErr) {
                console.error("[DEBUG] [handleUpdate] Error saving transactions from Telegram:", saveErr);
                return sendMessageToTelegram(chatId, "❌ Failed to save transaction(s) to your account. Please try again.");
            }
        } else {
            console.log("[DEBUG] [handleUpdate] Unable to extract valid expense details/amount from input.");
            const failMsg = hasPhoto
                ? "🤔 Couldn't detect clear expense details in that image. Please make sure the receipt or image text is readable."
                : "🤔 Sorry, I couldn't understand that expense structure. Try: 'uber 200 today' or send a receipt photo!";
            return sendMessageToTelegram(chatId, failMsg);
        }
    } catch (err) {
        console.error("[DEBUG] [handleUpdate] Telegram handling error:", err);
        return sendMessageToTelegram(chatId, "⚠️ Oops! Something went wrong while processing your request. Please try again later.");
    }
}

module.exports = {
    handleUpdate,
    parseWithAI,
    parseImageWithAI,
    getTelegramImageBase64,
    classifyCategoryWithFallbackAI
};
