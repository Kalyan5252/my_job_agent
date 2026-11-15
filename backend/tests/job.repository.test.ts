import test from 'node:test';
import assert from 'node:assert/strict';
import { JobRepository, StoredScoredJob } from '../src/repositories/job.repository';
import { ScoredJob } from '../src/types';

test('JobRepository upserts unique jobs and reports new vs existing rows', async () => {
  const collection = new FakeJobCollection([
    {
      source: 'linkedin-public',
      externalId: 'existing-1',
      title: 'Backend Engineer',
      company: 'Acme',
      description: 'existing',
      score: 80,
      apply: true,
      scrapeCount: 1,
      firstSeenAt: new Date('2026-01-01T00:00:00.000Z'),
      lastSeenAt: new Date('2026-01-01T00:00:00.000Z'),
    },
  ]);
  const repository = new JobRepository(async () => collection as never);
  const duplicateNewJob: ScoredJob = {
    source: 'remotive',
    externalId: 'new-1',
    title: 'Platform Engineer',
    company: 'Beta',
    description: 'new',
    score: 72,
    apply: true,
  };

  const result = await repository.saveDiscoveryJobs(
    [
      duplicateNewJob,
      duplicateNewJob,
      {
        source: 'linkedin-public',
        externalId: 'existing-1',
        title: 'Backend Engineer',
        company: 'Acme',
        description: 'updated',
        score: 84,
        apply: true,
      },
    ],
    { discoveryRunId: 'run-123' },
  );

  assert.equal(result.jobs.length, 2);
  assert.equal(result.newJobs.length, 1);
  assert.equal(result.existingJobs.length, 1);
  assert.equal(result.duplicateInputCount, 1);
  assert.equal(collection.records.size, 2);
  assert.equal(collection.indexes.length, 2);

  const updated = collection.records.get('linkedin-public::existing-1');
  assert.equal(updated?.description, 'updated');
  assert.equal(updated?.lastDiscoveryRunId, 'run-123');
  assert.equal(updated?.scrapeCount, 2);
});

class FakeJobCollection {
  readonly indexes: Array<{ spec: Record<string, number>; options?: Record<string, unknown> }> = [];
  readonly records = new Map<string, StoredScoredJob>();

  constructor(seed: StoredScoredJob[]) {
    for (const row of seed) {
      this.records.set(keyOf(row), row);
    }
  }

  async createIndex(
    spec: Record<string, number>,
    options?: Record<string, unknown>,
  ): Promise<string> {
    this.indexes.push({ spec, options });
    return String(options?.name || 'index');
  }

  find(query: { $or: Array<Pick<ScoredJob, 'source' | 'externalId'>> }) {
    const matches = query.$or
      .map((candidate) => this.records.get(keyOf(candidate)))
      .filter((value): value is StoredScoredJob => Boolean(value))
      .map((value) => ({ source: value.source, externalId: value.externalId }));

    return {
      toArray: async () => matches,
    };
  }

  async bulkWrite(
    operations: Array<{
      updateOne: {
        filter: Pick<ScoredJob, 'source' | 'externalId'>;
        update: {
          $set: StoredScoredJob;
          $setOnInsert: Partial<StoredScoredJob>;
          $inc: { scrapeCount: number };
        };
        upsert: boolean;
      };
    }>,
  ): Promise<{ upsertedCount: number; modifiedCount: number }> {
    let upsertedCount = 0;
    let modifiedCount = 0;

    for (const operation of operations) {
      // Mirror MongoDB: the same path in two update operators is a conflict error.
      const { $set, $setOnInsert, $inc } = operation.updateOne.update;
      const seen = new Set<string>();
      for (const key of [
        ...Object.keys($set),
        ...Object.keys($setOnInsert),
        ...Object.keys($inc),
      ]) {
        if (seen.has(key)) {
          throw new Error(`Updating the path '${key}' would create a conflict at '${key}'`);
        }
        seen.add(key);
      }
      const id = keyOf(operation.updateOne.filter);
      const existing = this.records.get(id);
      const next: StoredScoredJob = {
        ...(existing || {}),
        ...(existing ? {} : operation.updateOne.update.$setOnInsert),
        ...operation.updateOne.update.$set,
        scrapeCount: (existing?.scrapeCount || 0) + operation.updateOne.update.$inc.scrapeCount,
      };
      this.records.set(id, next);
      if (existing) modifiedCount += 1;
      else upsertedCount += 1;
    }

    return { upsertedCount, modifiedCount };
  }
}

function keyOf(job: Pick<ScoredJob, 'source' | 'externalId'>): string {
  return `${job.source}::${job.externalId}`;
}
