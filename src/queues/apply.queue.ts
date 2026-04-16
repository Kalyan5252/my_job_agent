import { Queue } from "bullmq";
import IORedis from "ioredis";
import { env } from "../config/env";
import { JobProfile, ScoredJob } from "../types";

export const APPLY_QUEUE_NAME = "apply-jobs";

export const redisConnection = new IORedis({
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  password: env.REDIS_PASSWORD
});

export const applyQueue = new Queue(APPLY_QUEUE_NAME, {
  connection: redisConnection
});

export interface ApplyJobPayload {
  job: ScoredJob;
  profile: JobProfile;
}

export async function enqueueApplication(payload: ApplyJobPayload): Promise<void> {
  await applyQueue.add("apply", payload, {
    attempts: 3,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: 100,
    removeOnFail: 200
  });
}
