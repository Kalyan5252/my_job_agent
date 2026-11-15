import { pgPool } from '../db/postgres/client';

export interface ApplicationRow {
  id: number;
  jobExternalId: string;
  source: string;
  company: string;
  role: string;
  status: string;
  notes: string | null;
  applyUrl: string | null;
  appliedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export class ApplicationRepository {
  async list(query: { status?: string; company?: string; limit: number; offset: number }) {
    const params = [query.status ?? null, query.company ? `%${query.company}%` : null];
    const where = `WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR company ILIKE $2)`;
    const [{ rows }, count] = await Promise.all([
      pgPool.query(
        `SELECT id, job_external_id, source, company, role, status, notes, apply_url,
                applied_at, created_at, updated_at
         FROM applications ${where}
         ORDER BY updated_at DESC
         LIMIT $3 OFFSET $4`,
        [...params, query.limit, query.offset],
      ),
      pgPool.query<{ total: string }>(
        `SELECT COUNT(*) AS total FROM applications ${where}`,
        params,
      ),
    ]);

    return {
      total: Number(count.rows[0]?.total ?? 0),
      items: rows.map((row): ApplicationRow => ({
        id: row.id,
        jobExternalId: row.job_external_id,
        source: row.source,
        company: row.company,
        role: row.role,
        status: row.status,
        notes: row.notes,
        applyUrl: row.apply_url,
        appliedAt: row.applied_at?.toISOString() ?? null,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      })),
    };
  }

  async statusCounts(): Promise<Record<string, number>> {
    const { rows } = await pgPool.query<{ status: string; total: string }>(
      'SELECT status, COUNT(*) AS total FROM applications GROUP BY status',
    );
    return Object.fromEntries(rows.map((row) => [row.status, Number(row.total)]));
  }
}
