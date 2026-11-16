# Asha photo editor with AI colour grading

## Run locally
1. Install Node 18 or newer.
2. Copy `.env.example` to `.env` and put your Groq key in it (`GROQ_API_KEY=gsk_...`).
3. `npm start`, then open http://localhost:3000

No key, or the AI is unreachable or out of quota? The app still grades, using the on-device skin check.

## Deploy on Pxxl
Add `GROQ_API_KEY` under Environment Variables. Start command: `npm start`. Never commit `.env`.

## Optional settings (environment variables)
`GROQ_MODEL` (default `qwen/qwen3.8-27b`), `AI_CONCURRENCY` (3), `AI_DAILY_LIMIT` per visitor (300), `AI_TIMEOUT_MS` (15000).

Check it is live: open `/api/health`.
