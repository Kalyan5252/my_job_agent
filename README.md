# AI Job Application Agent System

Multi-agent backend system that discovers jobs, applies with intelligent form handling, and tracks updates from email.

## Architecture

- `JobHunterAgent`: Fetches jobs, normalizes data, scores relevance, and queues applications.
- `ApplicationAgent`: Understands form fields, generates answers, fills forms via Playwright.
- `TrackerAgent`: Parses emails and updates application status in PostgreSQL.

## Stack

- Node.js + TypeScript + Fastify
- OpenAI API for reasoning/scoring
- Playwright for browser automation
- MongoDB (raw jobs + AI metadata)
- PostgreSQL (application tracking)
- Redis + BullMQ (queue/workers)

## Setup

1. Create/update `.env` in the project root and fill credentials.
2. Install deps:

```bash
npm install
```

3. Start API:

```bash
npm run dev
```

4. Start worker:

```bash
npm run dev:worker
```

5. Start scheduler:

```bash
npm run dev:cron
```

## Main Endpoints

- `GET /health`
- `POST /workflows/discovery/run`
- `POST /workflows/tracking/run`
- `POST /workflows/application/run`

## Notes

- CAPTCHA/anti-bot flows are handled with fallback + human-in-loop hooks.
- LLM actions include schema constraints and guard checks before submit.
- All automation decisions are auditable through structured logs.
- Optional Groq scraper-assist is supported for HTML extraction (`GROQ_SCRAPER_ENABLED=true`).
- Recommended pattern: use Groq OSS for extraction assistance and reserve OpenAI GPT-5 models for scoring/decision steps.

## Neon Postgres

- Set `POSTGRES_URL` to your Neon connection string (usually includes `sslmode=require`).
- Leave `POSTGRES_SSL_MODE=prefer` (default) or set `require` explicitly.
- Keep `POSTGRES_SSL_REJECT_UNAUTHORIZED=true` for production-safe TLS verification.
