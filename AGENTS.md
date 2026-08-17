# Spend Insight — Backend (Server)

Node/Express + MongoDB REST API for the **Spend Insight** personal finance tracker. Serves the React frontend (`SpendInsight/spend-insight`, deployed on Netlify), and powers a Telegram bot that lets users log expenses via text or receipt photos.

Production: `https://spend-insight-server.vercel.app` (Vercel serverless).

## Stack

- **Node.js / Express 4** — HTTP API (CommonJS, no build step)
- **Mongoose 7** — MongoDB ODM (db: `si-db`, collection: `users`)
- **Groq API** — LLM for expense extraction (text + receipt-image parsing) and category fallback classification
- **Telegram Bot API** — webhook + outbound messages
- **Vercel** — serverless deploy (`api/index.js` exports the Express app)
- `cors`, `body-parser`, `dotenv`

## How to run

```bash
npx nodemon server.js   # dev (see notes.txt); port defaults to 3001
node server.js          # production-style start
node test_learning_engine.js   # manual tests for categoryLearningEngine
```

Required env vars (`.env`, gitignored): `MONGODB_URI`, `GROQ_API_KEY`, `TELEGRAM_BOT_TOKEN`.

> `npm test` is a stub (`echo "Error: no test specified"`). The real test file is `test_learning_engine.js`, run manually.

## File layout

| File | Responsibility |
|------|----------------|
| `server.js` | Express app entry; all HTTP routes; `saveTransaction()` core logic; lazy DB connect |
| `api/index.js` | Vercel serverless entrypoint — just re-exports the app |
| `model.js` | Mongoose schemas (users / expenses / transactions / categories / keywords) |
| `telegramService.js` | Telegram webhook handler, Groq AI text/image parsing, outbound messages, `/link` flow |
| `categoryLearningEngine.js` | Keyword normalization, category scoring, confidence, keyword learning |
| `test_learning_engine.js` | Standalone assertion runner for the learning engine |
| `vercel.json` | Vercel rewrites (`/health`, `/api/*` → `/api`) + CORS headers |
| `.github/workflows/keep-alive.yml` | GitHub Action pings `/health` every 10 min to prevent server spin-down |
| `public/`, `graphify-out/` | Placeholder / gitignored cache — not app code |

## Data model (`model.js`)

Single `users` collection; expenses/categories/labels are embedded subdocuments.

- **User**: `userId` (Auth0 sub), `balance` (Number), `expenses[]`, `categories[]`, `labels[]`, `telegramId`, `telegramLinkingCode`, `telegramLinkingCodeExpires`
- **Expense**: `{ year, month, transactions[], savings, income[] }` — one document per user-month
- **Transaction**: `{ amount, category, label, notes, date, keywords[], learningStatus: { categoryId, categoryConfidence, categorySource } }`
  - `categorySource`: `'keyword_match' | 'category_name_match' | 'fallback_ai' | 'fallback_default' | 'user_corrected' | 'manual_entry'`
- **Category**: `{ categoryName, keywords: [{ word, weight }] }`
- **Income**: `{ amount, date, category, notes }`

Users, expense periods, and default categories are **created on demand** by `saveTransaction()` and the GET handlers — don't assume a user row exists.

## API routes (all in `server.js`)

Every route has a JSDoc `@route` block above it.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health`, `/api/health`, `/api/v1/health` | Keep-alive; lightweight DB ping |
| POST | `/api/v1/telegram` | Telegram webhook → `telegramService.handleUpdate` |
| GET | `/api/v1/transactions?userId&selectedMonth` | Transactions + savings + incomes + balance for a month |
| POST | `/api/v1/transactions` | Insert transaction(s) via `saveTransaction` |
| PUT | `/api/v1/transactions` | Update a transaction; category changes trigger learning (`user_corrected`) |
| DELETE | `/api/v1/transactions?userId&transactionId&date` | Delete; restores amount to savings + balance |
| GET | `/api/v1/categories/:userId` | List categories |
| POST | `/api/v1/categories` | Add category (409 if exists) |
| DELETE | `/api/v1/categories/:userId/:categoryId` | Remove category |
| GET | `/api/v1/labels/:userId` | List labels |
| POST | `/api/v1/labels` | Add label (409 if exists) |
| DELETE | `/api/v1/labels/:userId/:labelId` | Remove label |
| POST | `/api/v1/income` | Add income; credits savings + balance |
| GET | `/api/v1/income?userId&date` | Income, savings, balance for a month |
| DELETE | `/api/v1/income?userId&incomeId&date` | Delete income; debits savings + balance |
| GET | `/api/v1/user/linking-code?userId` | 5-char alphanumeric code (10 min expiry) for Telegram linking |

## Key logic to understand before editing

### Balance & savings math (`server.js`)
Plain `Number` arithmetic, no aggregation:
- **Expense added** → `expense.savings -= amount`, `user.balance -= amount`
- **Expense deleted** → `savings += amount`, `balance += amount`
- **Income added** → `savings += amount`, `balance += amount`
- **Income deleted** → `savings -= amount`, `balance -= amount`
- **PUT with changed amount** → adjust both by the diff (`newAmount - oldAmount`)

### Category learning (`categoryLearningEngine.js`)
- Keywords are normalized: lowercase, punctuation stripped, stop-words filtered, light singularization, synonym-mapped (`drinks→drink`, `groceries→grocery`, …). Capped at **3 keywords per transaction**.
- Scoring: learned keyword weights + a **+5 bonus** for matching the category name.
- Confidence tiers in `selectCategory`: high `keyword_match` (score ≥2 & lead ≥2) → medium `keyword_match` → `category_name_match` (0.5) → `fallback_ai` (0.4, Groq) → `fallback_default` (0.1).
- Learning increments: user correction **+3**, strong keyword match **+2**, normal **+1**. Max **10 keywords per category**; if full, the weakest keyword is replaced.
- `telegramService.classifyCategoryWithFallbackAI` is injected as the fallback AI — only called when keywords exist and local match is weak/absent.

### Telegram flow (`telegramService.js`)
1. `/link <CODE>` → looks up a user by `telegramLinkingCode` (must be unexpired), sets `telegramId`, returns confirmation.
2. Text message → `parseWithAI` (Groq `llama-3.3-70b-versatile`, `response_format: json_object`).
3. Photo/document → `parseImageWithAI` (Groq Vision `qwen/qwen3.6-27b`) after downloading via `getTelegramImageBase64`.
4. Parsed expenses → `saveTransaction(userId, expenses)`.
5. Parsing prompt rules are strict: **no merchant names, no category determination** in keywords — keywords describe the expense nature only. Preserve these rules if you touch the prompts.

### Serverless patterns
- Lazy MongoDB connection: `connectDB()` runs as request middleware and reuses a cached connection (`isConnected` / `readyState`).
- The Telegram webhook handler **awaits** `handleUpdate` before responding, so the serverless process doesn't freeze after `res.json()`.

## Gotchas / don't-break list

- **`mssql` is a dead dependency** — `const sql = require('mssql')` at the top of `server.js` is never used. Don't build on it; removing it is safe but optional.
- **`GET /api/v1/user` is incomplete/dead code** — it fetches the Auth0 Management API and only `console.log`s the result; it **never sends a response** (not even on success). Don't rely on it.
- CORS is restricted to a whitelist in `server.js` (Netlify prod, `localhost:3000`, a LAN IP). New frontend origins must be added there.
- `userId` is the Auth0 sub string; `transactionId`/`categoryId`/`labelId`/`incomeId` are MongoDB `_id`s.
- Dates are parsed per-request via `dateStringToMonthYear` (local time) — note GET `/transactions` uses `getUTCMonth()` while the rest use local `getMonth()`. Keep this consistent when changing date logic.
- `.env` is gitignored — never commit credentials.
- The parent `SpendInsight/spend-insight` folder is the **frontend** — keep frontend changes out of this repo.

## Conventions

- JSDoc `@route` block above **every** endpoint (100% coverage today — keep it that way).
- `[DEBUG]`-prefixed `console.log`/`console.error` for observability throughout.
- CommonJS (`require`/`module.exports`), 2-space indent.
- All route handlers are `async` + try/catch, responding `500` (`res.sendStatus(500)`) on error.
