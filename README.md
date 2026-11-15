# Distributed Job Agent System

Single-repo job automation platform with a Fastify/BullMQ backend and a Next.js dashboard.

## Layout

- `backend/` - API server, workers, queues, Playwright automation, scoring, persistence, OpenAPI, Bruno collections, profile data.
- `frontend/` - Next.js dashboard for discovery runs, queue health, source coverage, email digests, and human review handoff.
- root `package.json` - npm workspaces and orchestration scripts.

## What It Demonstrates

- 30+ configured company sources plus API/HTML/browser fallback strategies.
- Redis/BullMQ queues for scrape, score, write, and application work.
- Multiple workers with configurable concurrency.
- Queue priorities, retries, and exponential backoff.
- Source throttling to avoid hammering career sites.
- AI relevance scoring with rate-limit-aware fallback.
- Manual review queue for CAPTCHA/login/MFA style blockers.
- Email digest preview/send pipeline.
- Violet glassmorphism dashboard.

## Setup

```bash
npm install
```

Backend environment lives in `backend/.env`. The backend also checks the repo root for `.env` for compatibility.

## Development

Start API and dashboard:

```bash
npm run dev
```

Backend: `http://localhost:3000`

Frontend: `http://localhost:3001`

Start workers separately when Redis is enabled:

```bash
npm run dev:discovery-worker
npm run dev:worker
npm run dev:cron
```

## Production Build

```bash
npm run build
npm run start
```

## Important Endpoints

- `GET /health`
- `GET /dashboard/summary`
- `GET /manual-reviews`
- `POST /manual-reviews/:id/open`
- `POST /manual-reviews/:id/resume`
- `POST /manual-reviews/:id/resolve`
- `GET /digests/email/preview`
- `POST /digests/email/send`
- `POST /workflows/discovery/run`
- `POST /workflows/discovery/schedule`
- `POST /workflows/application/run`

## Human Review Flow

The agent does not bypass CAPTCHA or anti-abuse checks. When application automation reaches a blocker, the backend records a `blocked_manual_review` item with the company, role, URL, blocker code, screenshot path when available, and resume token. The dashboard shows it in the Human Review Queue. The user opens the URL/session, completes the manual step, then clicks Resume or Resolve.

## Useful Config

- `REDIS_ENABLED=true`
- `DISCOVERY_SCRAPE_WORKER_CONCURRENCY=4`
- `DISCOVERY_AI_WORKER_CONCURRENCY=4`
- `DISCOVERY_WRITE_WORKER_CONCURRENCY=2`
- `DISCOVERY_SOURCE_CONCURRENCY=5`
- `DISCOVERY_SOURCE_RATE_LIMIT_MS=750`
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `DIGEST_RECIPIENT_EMAIL`
- `NEXT_PUBLIC_API_BASE_URL=http://localhost:3000`
