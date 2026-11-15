import { Collection, Filter, ObjectId, WithId } from 'mongodb';
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
              ...withoutManagedFields(job),
              lastSeenAt: now,
              lastDiscoveryRunId: options.discoveryRunId,
            },
            // scrapeCount must only appear in $inc: MongoDB rejects the same path in
            // $setOnInsert and $inc ("would create a conflict"). $inc on insert starts at 1.
            $setOnInsert: {
              firstSeenAt: now,
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

  async list(query: JobListQuery): Promise<{ total: number; items: JobListItem[] }> {
    const collection = await this.collection();
    const filter: Filter<StoredScoredJob> = {};
    if (query.runId) filter.lastDiscoveryRunId = query.runId;
    if (query.apply !== undefined) filter.apply = query.apply;
    if (query.minScore !== undefined) filter.score = { $gte: query.minScore };
    if (query.source) filter.source = query.source;
    if (query.company) filter.company = { $regex: escapeRegex(query.company), $options: 'i' };
    if (query.q) {
      const rx = { $regex: escapeRegex(query.q), $options: 'i' };
      filter.$or = [{ title: rx }, { company: rx }, { description: rx }];
    }

    const sort: Record<string, 1 | -1> =
      query.sort === 'recent' ? { lastSeenAt: -1 } : { score: -1, lastSeenAt: -1 };
    const [total, docs] = await Promise.all([
      collection.countDocuments(filter),
      collection
        .find(filter)
        .sort(sort)
        .skip(query.offset ?? 0)
        .limit(query.limit ?? 50)
        .toArray(),
    ]);
    return { total, items: docs.map(toListItem) };
  }

  async findById(id: string): Promise<JobListItem | null> {
    if (!ObjectId.isValid(id)) return null;
    const collection = await this.collection();
    const doc = await collection.findOne({ _id: new ObjectId(id) } as Filter<StoredScoredJob>);
    return doc ? toListItem(doc) : null;
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

export interface JobListQuery {
  runId?: string;
  apply?: boolean;
  minScore?: number;
  source?: string;
  company?: string;
  q?: string;
  sort?: 'score' | 'recent';
  limit?: number;
  offset?: number;
}

export type JobListItem = StoredScoredJob & { id: string };

function toListItem(doc: WithId<StoredScoredJob>): JobListItem {
  const { _id, rawData: _rawData, ...rest } = doc;
  return { ...rest, id: _id.toHexString() };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Fields owned by the repository; never let caller input overwrite them via $set. */
function withoutManagedFields(job: ScoredJob): ScoredJob {
  const {
    _id: _ignoredId,
    id: _ignoredListId,
    scrapeCount: _scrapeCount,
    firstSeenAt: _firstSeenAt,
    lastSeenAt: _lastSeenAt,
    lastDiscoveryRunId: _lastRun,
    ...rest
  } = job as ScoredJob & Partial<StoredScoredJob> & { _id?: unknown; id?: unknown };
  return rest;
}
