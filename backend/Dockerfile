# Job Agent backend: API, workers and cron share this image (different commands).
# Build from the repo root:  docker build -f backend/Dockerfile -t job-agent-backend .
FROM oven/bun:1.3.9 AS bun

# Playwright image ships Chromium + all system deps, version-matched to playwright@1.59.1.
FROM mcr.microsoft.com/playwright:v1.59.1-noble

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
ENV NODE_ENV=production \
    DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=3000 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app
COPY package.json bun.lock ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN bun install --frozen-lockfile --production --filter @job-agent/backend

COPY backend/ backend/
WORKDIR /app/backend

# Run as the unprivileged user that the Playwright image provides.
RUN mkdir -p /data && chown -R pwuser:pwuser /data /app/backend
USER pwuser
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "src/server.ts"]
