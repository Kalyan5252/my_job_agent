import crypto from 'node:crypto';
import { pgPool } from '../db/postgres/client';
import { ApplicationRunOptions, ApplicationRunResult, ScoredJob } from '../types';

export type ManualReviewStatus =
  'blocked_manual_review' | 'user_reviewing' | 'resume_requested' | 'resolved';

export interface ManualReviewItem {
  id: string;
  status: ManualReviewStatus;
  blockerCode: string;
  blockerReason: string;
  company: string;
  title: string;
  applyUrl?: string;
  currentUrl?: string;
  screenshotPath?: string;
  lastStep: ApplicationRunResult['stage'];
  job: ScoredJob;
  runOptions?: ApplicationRunOptions;
  createdAt: string;
  updatedAt: string;
  notes?: string;
}

interface Row {
  id: string;
  status: ManualReviewStatus;
  blocker_code: string;
  blocker_reason: string;
  company: string;
  title: string;
  apply_url: string | null;
  current_url: string | null;
  screenshot_path: string | null;
  last_step: ApplicationRunResult['stage'];
  job: ScoredJob;
  run_options: ApplicationRunOptions | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

function toItem(row: Row): ManualReviewItem {
  return {
    id: row.id,
    status: row.status,
    blockerCode: row.blocker_code,
    blockerReason: row.blocker_reason,
    company: row.company,
    title: row.title,
    applyUrl: row.apply_url ?? undefined,
    currentUrl: row.current_url ?? undefined,
    screenshotPath: row.screenshot_path ?? undefined,
    lastStep: row.last_step,
    job: row.job,
    runOptions: row.run_options ?? undefined,
    notes: row.notes ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Human-review queue for applications blocked by CAPTCHA/login/validation. Stored in Postgres. */
export class ManualReviewService {
  async createFromApplicationResult(
    job: ScoredJob,
    result: ApplicationRunResult,
    runOptions?: ApplicationRunOptions,
  ): Promise<ManualReviewItem | null> {
    if (result.status !== 'needs_human') return null;

    const { rows } = await pgPool.query<Row>(
      `INSERT INTO manual_reviews
        (id, status, blocker_code, blocker_reason, company, title, apply_url, current_url,
         screenshot_path, last_step, job, run_options)
       VALUES ($1, 'blocked_manual_review', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        `review-${crypto.randomUUID()}`,
        result.errorCode || 'UNKNOWN',
        result.message,
        job.company,
        job.title,
        job.applyUrl ?? null,
        result.targetUrl || result.applyUrl || null,
        result.previewScreenshots?.[0] ?? null,
        result.stage,
        JSON.stringify(job),
        runOptions ? JSON.stringify(runOptions) : null,
      ],
    );
    return toItem(rows[0]);
  }

  async list(
    options: { status?: ManualReviewStatus; limit?: number } = {},
  ): Promise<ManualReviewItem[]> {
    const { rows } = await pgPool.query<Row>(
      `SELECT * FROM manual_reviews
       WHERE ($1::text IS NULL OR status = $1)
       ORDER BY created_at DESC
       LIMIT $2`,
      [options.status ?? null, Math.min(options.limit ?? 100, 500)],
    );
    return rows.map(toItem);
  }

  async counts(): Promise<{ open: number; total: number }> {
    const { rows } = await pgPool.query<{ open: string; total: string }>(
      `SELECT COUNT(*) FILTER (WHERE status <> 'resolved') AS open, COUNT(*) AS total FROM manual_reviews`,
    );
    return { open: Number(rows[0]?.open ?? 0), total: Number(rows[0]?.total ?? 0) };
  }

  async get(id: string): Promise<ManualReviewItem | undefined> {
    const { rows } = await pgPool.query<Row>('SELECT * FROM manual_reviews WHERE id = $1', [id]);
    return rows[0] ? toItem(rows[0]) : undefined;
  }

  async markReviewing(id: string): Promise<ManualReviewItem | undefined> {
    return this.update(id, 'user_reviewing');
  }

  async requestResume(id: string, notes?: string): Promise<ManualReviewItem | undefined> {
    return this.update(id, 'resume_requested', notes);
  }

  async resolve(id: string, notes?: string): Promise<ManualReviewItem | undefined> {
    return this.update(id, 'resolved', notes);
  }

  private async update(
    id: string,
    status: ManualReviewStatus,
    notes?: string,
  ): Promise<ManualReviewItem | undefined> {
    const { rows } = await pgPool.query<Row>(
      `UPDATE manual_reviews
       SET status = $2, notes = COALESCE($3, notes), updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id, status, notes ?? null],
    );
    return rows[0] ? toItem(rows[0]) : undefined;
  }
}
