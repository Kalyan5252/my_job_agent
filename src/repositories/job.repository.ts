import { Collection } from 'mongodb';
import { jobsCollection } from '../db/mongo/client';
import { ScoredJob } from '../types';

export interface StoredScoredJob extends ScoredJob {
  firstSeenAt?: Date;
  lastSeenAt?: Date;
  scrapeCount?: number;
  lastDiscoveryRunId?: string;
}

export interface SaveDiscoveryJobsResult {
  jobs: ScoredJob[];
  newJobs: ScoredJob[];
  existingJobs: ScoredJob[];
  insertedCount: number;
  updatedCount: number;
  duplicateInputCount: number;
}

export class JobRepository {
  private indexesReady = false;

  constructor(
    private readonly collectionProvider: () => Promise<Collection<StoredScoredJob>> = async () =>
      (await jobsCollection()) as Collection<StoredScoredJob>,
  ) {}

  async saveDiscoveryJobs(
    jobs: ScoredJob[],
    options: { discoveryRunId?: string } = {},
  ): Promise<SaveDiscoveryJobsResult> {
    const collection = await this.collection();
    const uniqueJobs = this.dedupeInput(jobs);
    const duplicateInputCount = jobs.length - uniqueJobs.length;

    if (uniqueJobs.length === 0) {
      return {
        jobs: [],
        newJobs: [],
        existingJobs: [],
        insertedCount: 0,
        updatedCount: 0,
        duplicateInputCount,
      };
    }

    await this.ensureIndexes(collection);

    const existingKeys = new Set(
      (
        await collection
          .find(
            {
              $or: uniqueJobs.map((job) => ({
                source: job.source,
                externalId: job.externalId,
              })),
            },
            { projection: { source: 1, externalId: 1 } },
          )
          .toArray()
      ).map((job) => this.key(job)),
    );

    const now = new Date();
    const result = await collection.bulkWrite(
      uniqueJobs.map((job) => ({
        updateOne: {
          filter: { source: job.source, externalId: job.externalId },
          update: {
            $set: {
              ...job,
              lastSeenAt: now,
              lastDiscoveryRunId: options.discoveryRunId,
            },
            $setOnInsert: {
              firstSeenAt: now,
              scrapeCount: 0,
            },
            $inc: { scrapeCount: 1 },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    );

    const newJobs = uniqueJobs.filter((job) => !existingKeys.has(this.key(job)));
    const existingJobs = uniqueJobs.filter((job) => existingKeys.has(this.key(job)));

    return {
      jobs: uniqueJobs,
      newJobs,
      existingJobs,
      insertedCount: result.upsertedCount,
      updatedCount: result.modifiedCount,
      duplicateInputCount,
    };
  }

  private async collection(): Promise<Collection<StoredScoredJob>> {
    return this.collectionProvider();
  }

  private async ensureIndexes(collection: Collection<StoredScoredJob>): Promise<void> {
    if (this.indexesReady) return;

    try {
      await collection.createIndex(
        { source: 1, externalId: 1 },
        { unique: true, name: 'ux_jobs_source_external_id' },
      );
      await collection.createIndex({ lastSeenAt: -1 }, { name: 'ix_jobs_last_seen_at' });
      this.indexesReady = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown index error';
      console.warn(`[job-repository] index setup skipped: ${message}`);
    }
  }

  private dedupeInput(jobs: ScoredJob[]): ScoredJob[] {
    const seen = new Set<string>();
    const output: ScoredJob[] = [];

    for (const job of jobs) {
      const key = this.key(job);
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(job);
    }

    return output;
  }

  private key(job: Pick<ScoredJob, 'source' | 'externalId'>): string {
    return `${job.source}::${job.externalId}`;
  }
}
