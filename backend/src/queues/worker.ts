import { Job, Worker } from 'bullmq';
import { env } from '../config/env';
import { closeMongo, connectMongo } from '../db/mongo/client';
import { closePostgres, initPostgres } from '../db/postgres/client';
import { ApplicationService } from '../services/application.service';
import { ManualReviewService } from '../services/manualReview.service';
import { BrowserTool } from '../tools/browser.tool';
import {
  APPLY_QUEUE_NAME,
  ApplyJobPayload,
  closeRedis,
  getRedisConnection,
  isRedisEnabled,
} from './apply.queue';
import { installShutdown } from '../lib/shutdown';

async function main() {
  if (!isRedisEnabled()) {
    throw new Error('Worker cannot start because REDIS_ENABLED=false. Set REDIS_ENABLED=true.');
  }

  await connectMongo();
  await initPostgres();

  const applications = new ApplicationService();
  const reviews = new ManualReviewService();

  const worker = new Worker<ApplyJobPayload>(
    APPLY_QUEUE_NAME,
    async (job: Job<ApplyJobPayload>) => {
      const outcome = await applications.run(job.data.job, job.data.profile, job.data.options);
      if (job.data.reviewId && outcome.result.status !== 'needs_human') {
        await reviews.resolve(
          job.data.reviewId,
          `Resumed run finished with status=${outcome.result.status}`,
        );
      }
      return outcome;
    },
    { connection: getRedisConnection(), concurrency: env.APPLY_WORKER_CONCURRENCY },
  );

  worker.on('completed', (job) => console.log(`[apply-worker] completed ${job.id}`));
  worker.on('failed', (job, err) => console.error(`[apply-worker] failed ${job?.id}`, err));

  installShutdown('apply-worker', async () => {
    await worker.close();
    await BrowserTool.closePool();
    await closeRedis();
    await closePostgres();
    await closeMongo();
  });

  console.log(`[apply-worker] started (concurrency=${env.APPLY_WORKER_CONCURRENCY})`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
