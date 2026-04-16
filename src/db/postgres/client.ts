import { Pool } from "pg";
import { env } from "../../config/env";

export const pgPool = new Pool({
  connectionString: env.POSTGRES_URL
});

export async function initPostgres(): Promise<void> {
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
