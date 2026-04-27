import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { env } from '../config/env';
import { JobProfile, ScoredJob } from '../types';

export const APPLY_QUEUE_NAME = 'apply-jobs';

let redisConnection: IORedis | null = null;
let applyQueue: Queue | null = null;

export interface ApplyJobPayload {
  job: ScoredJob;
  profile: JobProfile;
}

export async function enqueueApplication(payload: ApplyJobPayload): Promise<void> {
  if (!isRedisEnabled()) {
    console.warn('[queue] Redis disabled. Skipping application enqueue.');
    return;
  }

  const queue = getApplyQueue();
  await queue.add('apply', payload, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: 100,
    removeOnFail: 200,
  });
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

export function getApplyQueue(): Queue {
  if (!applyQueue) {
    applyQueue = new Queue(APPLY_QUEUE_NAME, {
      connection: getRedisConnection(),
    });
  }

  return applyQueue;
}
