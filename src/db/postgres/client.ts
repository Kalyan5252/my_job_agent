import { Pool } from 'pg';
import { env } from '../../config/env';

export const pgPool = new Pool({
  connectionString: env.POSTGRES_URL,
  ssl: resolveSslConfig(),
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

export async function initPostgres(): Promise<void> {
  validatePostgresUrl(env.POSTGRES_URL);
  await pgPool.query('SELECT 1');

  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS applications (
      id SERIAL PRIMARY KEY,
      job_external_id TEXT NOT NULL,
      source TEXT NOT NULL,
      company TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL,
      notes TEXT,
      applied_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pgPool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_applications_source_job
    ON applications(source, job_external_id);
  `);
}

function validatePostgresUrl(url: string): void {
  if (/[<>]/.test(url) || url.includes('<user>') || url.includes('<password>')) {
    throw new Error(
      'Invalid POSTGRES_URL: placeholder value detected. Put your real Neon URI in .env as POSTGRES_URL=postgresql://...',
    );
  }

  try {
    const parsed = new URL(url);
    const allowedProtocols = new Set(['postgres:', 'postgresql:']);
    if (!allowedProtocols.has(parsed.protocol)) {
      throw new Error(`Unsupported protocol: ${parsed.protocol}`);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown reason';
    throw new Error(
      `Invalid POSTGRES_URL. Use full Neon URI format like postgresql://user:password@host/db?sslmode=require. Reason: ${reason}`,
    );
  }
}

function resolveSslConfig(): false | { rejectUnauthorized: boolean } {
  const mode = env.POSTGRES_SSL_MODE;
  const lowerUrl = env.POSTGRES_URL.toLowerCase();
  const urlForcesSsl = lowerUrl.includes('sslmode=require');
  const neonHost = lowerUrl.includes('.neon.tech');

  if (mode === 'disable') return false;
  if (mode === 'require' || urlForcesSsl || neonHost) {
    return { rejectUnauthorized: env.POSTGRES_SSL_REJECT_UNAUTHORIZED };
  }

  return false;
}
