import crypto from 'node:crypto';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { env } from '../config/env';
import { HttpError } from '../lib/httpError';
import { ApplicationRunOptions, JobProfile, ScoredJob } from '../types';

export const APPLY_QUEUE_NAME = 'apply-jobs';

let redisConnection: IORedis | null = null;
let applyQueue: Queue<ApplyJobPayload> | null = null;

export interface ApplyJobPayload {
  job: ScoredJob;
  profile: JobProfile;
  options?: ApplicationRunOptions;
  reviewId?: string;
}

export async function enqueueApplication(payload: ApplyJobPayload): Promise<{ jobId: string }> {
  if (!isRedisEnabled()) {
    throw new HttpError(
      409,
      'Queued applications need Redis (REDIS_ENABLED=true). Use the synchronous endpoint instead.',
    );
  }

  const jobId = `apply-${crypto.randomUUID()}`;
  await getApplyQueue().add('apply', payload, {
    jobId,
    // Submitting twice is worse than not submitting; retries only for dry-runs.
    attempts: payload.options?.mode === 'submit' ? 1 : 3,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: 500,
    removeOnFail: 500,
  });
  return { jobId };
}

export async function getApplicationJobStatus(jobId: string) {
  const job = await getApplyQueue().getJob(jobId);
  if (!job) return null;
  return {
    jobId,
    state: await job.getState(),
    attemptsMade: job.attemptsMade,
    failedReason: job.failedReason || undefined,
    createdAt: new Date(job.timestamp).toISOString(),
    finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : undefined,
    outcome: job.returnvalue ?? undefined,
  };
}

export function isRedisEnabled(): boolean {
  return env.REDIS_ENABLED;
}

export function getRedisConnection(): IORedis {
  if (!isRedisEnabled()) {
    throw new Error('Redis is disabled. Set REDIS_ENABLED=true to use queue workers.');
  }

  if (!redisConnection) {
    redisConnection = new IORedis({
      host: env.REDIS_HOST,
      port: env.REDIS_PORT,
      password: env.REDIS_PASSWORD,
      lazyConnect: true,
      maxRetriesPerRequest: null,
    });
  }

  return redisConnection;
}

export async function closeRedis(): Promise<void> {
  await applyQueue?.close().catch(() => undefined);
  applyQueue = null;
  await redisConnection?.quit().catch(() => undefined);
  redisConnection = null;
}

export function getApplyQueue(): Queue<ApplyJobPayload> {
  if (!applyQueue) {
    applyQueue = new Queue<ApplyJobPayload>(APPLY_QUEUE_NAME, {
      connection: getRedisConnection(),
    });
  }

  return applyQueue;
}
