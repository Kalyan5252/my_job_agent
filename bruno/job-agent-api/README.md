# Bruno Collection: Job Agent API

## Import

1. Open Bruno
2. Click `Open Collection`
3. Select `bruno/job-agent-api`
4. Pick environment `local`

## Endpoints Included

- `GET /health`
- `POST /workflows/discovery/run`
- `POST /workflows/tracking/run`
- `POST /workflows/application/run`

## Notes

- Default `baseUrl` is `http://localhost:3000`
- `run-application` uses a sample payload compatible with current `ScoredJob` + `JobProfile` shape
