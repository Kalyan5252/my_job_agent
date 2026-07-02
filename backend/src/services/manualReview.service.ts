import fs from 'node:fs/promises';
import path from 'node:path';
import { ApplicationRunResult, ScoredJob } from '../types';

export type ManualReviewStatus = 'blocked_manual_review' | 'user_reviewing' | 'resume_requested' | 'resolved';

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
  resumeToken: string;
  createdAt: string;
  updatedAt: string;
  notes?: string;
}

export class ManualReviewService {
  constructor(private readonly filePath = path.resolve(process.cwd(), 'data/control-plane/manual-reviews.json')) {}

  async createFromApplicationResult(job: ScoredJob, result: ApplicationRunResult): Promise<ManualReviewItem | null> {
    if (result.status !== 'needs_human') return null;

    const now = new Date().toISOString();
    const item: ManualReviewItem = {
      id: `review-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      status: 'blocked_manual_review',
      blockerCode: result.errorCode || 'UNKNOWN',
      blockerReason: result.message,
      company: job.company,
      title: job.title,
      applyUrl: job.applyUrl,
      currentUrl: result.targetUrl || result.applyUrl,
      screenshotPath: result.previewScreenshots?.[0],
      lastStep: result.stage,
      resumeToken: `resume-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      createdAt: now,
      updatedAt: now,
    };

    const items = await this.list();
    await this.write([item, ...items]);
    return item;
  }

  async list(): Promise<ManualReviewItem[]> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as ManualReviewItem[];
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async markReviewing(id: string): Promise<ManualReviewItem | undefined> {
    return this.update(id, { status: 'user_reviewing' });
  }

  async requestResume(id: string, notes?: string): Promise<ManualReviewItem | undefined> {
    return this.update(id, { status: 'resume_requested', notes });
  }

  async resolve(id: string, notes?: string): Promise<ManualReviewItem | undefined> {
    return this.update(id, { status: 'resolved', notes });
  }

  private async update(
    id: string,
    patch: Partial<Pick<ManualReviewItem, 'status' | 'notes'>>,
  ): Promise<ManualReviewItem | undefined> {
    const items = await this.list();
    const index = items.findIndex((item) => item.id === id);
    if (index === -1) return undefined;

    items[index] = {
      ...items[index],
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    await this.write(items);
    return items[index];
  }

  private async write(items: ManualReviewItem[]): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, `${JSON.stringify(items, null, 2)}\n`);
  }
}
