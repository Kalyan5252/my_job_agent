import { Job, Worker } from 'bullmq';
import { ApplyWorkflow } from '../workflows/apply.workflow';
import {
  APPLY_QUEUE_NAME,
  ApplyJobPayload,
  getRedisConnection,
  isRedisEnabled,
} from './apply.queue';

const workflow = new ApplyWorkflow();

if (!isRedisEnabled()) {
  throw new Error('Worker cannot start because REDIS_ENABLED=false. Set REDIS_ENABLED=true.');
}

const worker = new Worker(
  APPLY_QUEUE_NAME,
  async (job: Job<ApplyJobPayload>) => {
    await workflow.run(job.data);
  },
  { connection: getRedisConnection(), concurrency: 2 },
);

worker.on('completed', (job) => {
  console.log(`Apply job completed: ${job.id}`);
});

worker.on('failed', (job, err) => {
  console.error(`Apply job failed: ${job?.id}`, err);
});

console.log('Application worker started');
