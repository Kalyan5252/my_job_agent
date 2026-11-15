import cron from 'node-cron';
import { env, splitList } from '../src/config/env';
import { closeMongo, connectMongo } from '../src/db/mongo/client';
import { closePostgres, initPostgres } from '../src/db/postgres/client';
import { installShutdown } from '../src/lib/shutdown';
import { closeRedis, isRedisEnabled } from '../src/queues/apply.queue';
import { BrowserTool } from '../src/tools/browser.tool';
import { DiscoveryWorkflow } from '../src/workflows/discovery.workflow';
import { TrackingWorkflow } from '../src/workflows/tracking.workflow';

/** Wraps a cron task so it never overlaps itself and never crashes the process. */
function guarded(name: string, task: () => Promise<void>): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) {
      console.warn(`[cron:${name}] previous run still in progress; skipping`);
      return;
    }
    running = true;
    const started = Date.now();
    try {
      await task();
      console.log(`[cron:${name}] finished in ${Date.now() - started}ms`);
    } catch (error) {
      console.error(`[cron:${name}] failed`, error);
    } finally {
      running = false;
    }
  };
}

async function main() {
  for (const [name, expr] of [
    ['DISCOVERY_CRON', env.DISCOVERY_CRON],
    ['TRACKING_CRON', env.TRACKING_CRON],
  ]) {
    if (!cron.validate(expr)) throw new Error(`Invalid ${name}: "${expr}"`);
  }

  await connectMongo();
  await initPostgres();

  const discovery = new DiscoveryWorkflow();
  const tracking = new TrackingWorkflow();
  const profile = {
    role: env.DEFAULT_JOB_ROLE,
    skills: splitList(env.DEFAULT_JOB_SKILLS),
    experience: env.DEFAULT_JOB_EXPERIENCE,
  };

  const tasks = [
    cron.schedule(
      env.DISCOVERY_CRON,
      guarded('discovery', async () => {
        if (isRedisEnabled()) {
          const result = await discovery.schedule(profile);
          console.log(`[cron:discovery] queued runId=${result.runId}`);
          return;
        }
        const result = await discovery.run(profile);
        console.log(`[cron:discovery] total=${result.total} apply=${result.applyCount}`);
      }),
    ),
    cron.schedule(
      env.TRACKING_CRON,
      guarded('tracking', async () => {
        const result = await tracking.run();
        console.log(`[cron:tracking] scanned=${result.scannedEmails} updates=${result.updates}`);
      }),
    ),
  ];

  installShutdown('cron', async () => {
    tasks.forEach((task) => task.stop());
    await BrowserTool.closePool();
    await closeRedis();
    await closePostgres();
    await closeMongo();
  });

  console.log(`[cron] running: discovery "${env.DISCOVERY_CRON}", tracking "${env.TRACKING_CRON}"`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
