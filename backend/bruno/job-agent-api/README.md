# Bruno collection: Job Agent API

1. Open Bruno → **Open Collection** → select `backend/bruno/job-agent-api`.
2. Pick the `local` (or `production`) environment and set the secret `password`
   (or paste an API key from `API_KEYS` into `token`).
3. Run **Auth / Login** – it saves the bearer token into `token`. Every other
   request inherits `Authorization: Bearer {{token}}`.

Typical flow: Profile → Upload resume → Patch manual profile → Sessions (save LinkedIn/Google)
→ Discovery → Jobs → Apply (dry-run first) → Manual Reviews → Applications.

Requests that return ids (`runId`, `jobId`, `reviewId`, `queuedJobId`, `loginId`) store them
in environment variables automatically for the follow-up requests.
