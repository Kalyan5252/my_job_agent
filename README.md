# Job Agent

API-first job automation: discovers jobs from 30+ sources, scores them against your
resume, fills (or submits) applications with Playwright, tracks replies from your inbox,
and hands anything it can't do (CAPTCHA, login, unknown questions) to a human-review queue.

Everything is driven over HTTP: use `curl`, Postman, Bruno (`backend/bruno/job-agent-api`)
or Swagger UI at `/api-docs`.

## Layout

- `backend/` – Fastify API, BullMQ workers, cron, Playwright automation, OpenAPI spec, Bruno collection.
- `frontend/` – Next.js dashboard (optional; not needed to use the API).
- `docker-compose.yml` – production stack (API, workers, cron, MongoDB, Postgres, Redis).

## Quick start (local)

```bash
bun install
bun run --cwd backend browsers:install      # Playwright Chromium (or set BROWSER_CHANNEL=chrome)
cp backend/.env.example backend/.env
bun run auth:hash-password --secrets        # prints ADMIN_PASSWORD_HASH, AUTH_TOKEN_SECRET, API_KEYS, DATA_ENCRYPTION_KEY
```

Paste the printed values into `backend/.env`, set `MONGODB_URI` / `POSTGRES_URL`, then:

```bash
bun run dev
```

API: `http://localhost:3000` · Docs: `http://localhost:3000/api-docs`

Workers (need `REDIS_ENABLED=true`):

```bash
bun run dev:discovery-worker
bun run dev:worker
bun run dev:cron
```

## Production (Docker)

```bash
cp backend/.env.example backend/.env   # fill in secrets; NODE_ENV=production is enforced by compose
export POSTGRES_PASSWORD=... REDIS_PASSWORD=...
docker compose up -d --build
```

In production the API refuses to start without API credentials (`API_KEYS` and/or
`ADMIN_PASSWORD_HASH` + `AUTH_TOKEN_SECRET`) and `DATA_ENCRYPTION_KEY`. All runtime data
(resumes, profiles, encrypted login sessions, screenshots) lives in the `/data` volume.
Put the API behind HTTPS (reverse proxy) and set `TRUST_PROXY=true`.

## Using the API

Every route except `/health`, `/health/ready`, `/auth/login` and the docs needs
`Authorization: Bearer <token or API key>` (or `x-api-key: <API key>`).

```bash
URL=http://localhost:3000

# 1. Log in (or use an API key directly as the bearer token)
TOKEN=$(curl -s -X POST $URL/auth/login -H 'content-type: application/json' \
  -d '{"username":"admin","password":"<your password>"}' | jq -r .accessToken)
AUTH="Authorization: Bearer $TOKEN"

# 2. Upload your resume (PDF) – builds the candidate profile automatically
curl -X POST "$URL/profile/resume?identity=primary" -H "$AUTH" -F file=@resume.pdf

# 3. Add what the resume can't tell (contact, notice period, salary, skill years)
curl -X PATCH $URL/profile/manual -H "$AUTH" -H 'content-type: application/json' \
  -d '{"emails":["you@example.com"],"phones":["+91 90000 00000"],"preferences":{"noticePeriodDays":0,"expectedSalaryLpa":12}}'

# 4. Save your LinkedIn / Google login (opens a browser on YOUR machine, uploads to the API)
JOB_AGENT_API_URL=$URL JOB_AGENT_TOKEN=$TOKEN bun run session linkedin
curl -X POST $URL/sessions/linkedin/verify -H "$AUTH"

# 5. Discover and review jobs
curl -X POST $URL/workflows/discovery/run -H "$AUTH" -H 'content-type: application/json' \
  -d '{"role":"Backend Engineer","country":"India","locations":["Bengaluru"],"maxResults":30}'
curl "$URL/jobs?apply=true&minScore=70" -H "$AUTH"

# 6. Apply (dry-run fills the form without submitting; use "submit" when you're happy)
curl -X POST $URL/jobs/<jobId>/apply -H "$AUTH" -H 'content-type: application/json' \
  -d '{"options":{"mode":"dry-run","preview":true}}'

# 7. Handle blocked applications
curl "$URL/manual-reviews?status=blocked_manual_review" -H "$AUTH"
curl -X POST $URL/manual-reviews/<id>/resume -H "$AUTH"   # re-run after fixing the blocker
```

### Endpoint overview

| Area         | Endpoints                                                                                                                                             |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Health       | `GET /health`, `GET /health/ready`                                                                                                                    |
| Auth         | `POST /auth/login`, `GET /auth/me`                                                                                                                    |
| Profile      | `GET /profile`, `POST/GET/DELETE /profile/resume`, `GET/PATCH /profile/candidate`, `GET/PUT/PATCH /profile/manual`                                    |
| Sessions     | `GET /sessions`, `GET/PUT/DELETE /sessions/:provider`, `POST /sessions/:provider/verify`, `POST /sessions/:provider/login` (+ `/complete`)            |
| Discovery    | `POST /workflows/discovery/run`, `POST /workflows/discovery/schedule`, `GET /workflows/discovery/runs/:runId`, `POST /workflows/discovery/understand` |
| Jobs         | `GET /jobs`, `GET /jobs/:id`, `POST /jobs/:id/apply`                                                                                                  |
| Applications | `POST /workflows/application/run`, `POST /workflows/application/schedule`, `GET /workflows/application/jobs/:jobId`, `GET /applications`              |
| Review queue | `GET /manual-reviews`, `GET /manual-reviews/:id`, `GET /manual-reviews/:id/screenshot`, `POST .../open`, `.../resume`, `.../resolve`                  |
| Tracking     | `POST /workflows/tracking/run`                                                                                                                        |
| Dashboard    | `GET /dashboard/summary`, `GET /digests/email/preview`, `POST /digests/email/send`                                                                    |

### LinkedIn / Google sessions

The application agent reuses your logged-in browser sessions. Three ways to save one:

1. **CLI (recommended, works with a remote server):** `bun run session linkedin` – log in
   in the window that opens; the session is uploaded to `PUT /sessions/linkedin`.
   For Google use `bun run session google --chrome-cdp` (signs in through your real Chrome).
2. **Interactive via API (API running on your own machine):** `POST /sessions/linkedin/login`,
   sign in in the window that opens, then `POST /sessions/linkedin/login/{loginId}/complete`.
3. **Upload JSON:** `PUT /sessions/:provider` with a Playwright storage state.

Sessions are encrypted at rest (AES-256-GCM, `DATA_ENCRYPTION_KEY`) and never returned by the API.

## Human review flow

The agent does not bypass CAPTCHA or anti-abuse checks. When an application hits a blocker
it records a review item (blocker code, URL, screenshot when `preview` is on, and the job
itself). Fix the blocker (e.g. refresh the session, apply by hand) and call
`POST /manual-reviews/:id/resume` to re-run it, or `/resolve` to close it.

## Tests

```bash
bun run test
bun run --cwd backend typecheck
```
