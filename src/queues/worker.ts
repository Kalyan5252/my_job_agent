import { Job, Worker } from "bullmq";
import { ApplyWorkflow } from "../workflows/apply.workflow";
import { APPLY_QUEUE_NAME, ApplyJobPayload, redisConnection } from "./apply.queue";

const workflow = new ApplyWorkflow();

const worker = new Worker(
  APPLY_QUEUE_NAME,
  async (job: Job<ApplyJobPayload>) => {
    await workflow.run(job.data);
  },
  { connection: redisConnection, concurrency: 2 }
);

worker.on("completed", (job) => {
  console.log(`Apply job completed: ${job.id}`);
});

worker.on("failed", (job, err) => {
  console.error(`Apply job failed: ${job?.id}`, err);
});

console.log("Application worker started");
