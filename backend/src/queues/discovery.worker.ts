import { Job, Worker } from 'bullmq';
import { env } from '../config/env';
import { DiscoveryTaskDispatcher } from '../pipeline/discovery.dispatcher';
import {
  DiscoveryScoreProcessor,
  DiscoveryScrapeProcessor,
  DiscoveryWriteProcessor,
} from '../pipeline/discovery.processors';
import { ConsolePipelineEventBus } from '../pipeline/eventBus';
import {
  DiscoveryScoreTask,
  DiscoveryScrapeTask,
  DiscoveryWriteTask,
} from '../pipeline/discovery.types';
import {
  DISCOVERY_SCORE_QUEUE_NAME,
  DISCOVERY_SCRAPE_QUEUE_NAME,
  DISCOVERY_WRITE_QUEUE_NAME,
  BullDiscoveryTaskDispatcher,
} from './discovery.queue';
import { getRedisConnection, isRedisEnabled } from './apply.queue';
import { DiscoveryScrapeService } from '../services/discoveryScrape.service';
import { DiscoveryScoreService } from '../services/discoveryScore.service';
import { DiscoveryWriteService } from '../services/discoveryWrite.service';

export interface DiscoveryWorkerBundle {
  scrapeWorker: Worker<DiscoveryScrapeTask>;
  scoreWorker: Worker<DiscoveryScoreTask>;
  writeWorker: Worker<DiscoveryWriteTask>;
}

export function startDiscoveryWorkers(
  dispatcher: DiscoveryTaskDispatcher = new BullDiscoveryTaskDispatcher(),
): DiscoveryWorkerBundle {
  if (!isRedisEnabled()) {
    throw new Error('Discovery workers cannot start because REDIS_ENABLED=false.');
  }

  const events = new ConsolePipelineEventBus();
  const scrapeProcessor = new DiscoveryScrapeProcessor(
    new DiscoveryScrapeService(),
    dispatcher,
    events,
  );
  const scoreProcessor = new DiscoveryScoreProcessor(
    new DiscoveryScoreService(),
    dispatcher,
    events,
  );
  const writeProcessor = new DiscoveryWriteProcessor(new DiscoveryWriteService(), events);
  const connection = getRedisConnection();

  const scrapeWorker = new Worker(
    DISCOVERY_SCRAPE_QUEUE_NAME,
    async (job: Job<DiscoveryScrapeTask>) => {
      await scrapeProcessor.process(job.data);
    },
    { connection, concurrency: env.DISCOVERY_SCRAPE_WORKER_CONCURRENCY },
  );

  const scoreWorker = new Worker(
    DISCOVERY_SCORE_QUEUE_NAME,
    async (job: Job<DiscoveryScoreTask>) => {
      await scoreProcessor.process(job.data);
    },
    { connection, concurrency: env.DISCOVERY_AI_WORKER_CONCURRENCY },
  );

  const writeWorker = new Worker(
    DISCOVERY_WRITE_QUEUE_NAME,
    async (job: Job<DiscoveryWriteTask>) => {
      await writeProcessor.process(job.data);
    },
    { connection, concurrency: env.DISCOVERY_WRITE_WORKER_CONCURRENCY },
  );

  attachLogging('scrape', scrapeWorker);
  attachLogging('score', scoreWorker);
  attachLogging('write', writeWorker);

  return { scrapeWorker, scoreWorker, writeWorker };
}

function attachLogging<T>(name: string, worker: Worker<T>): void {
  worker.on('completed', (job) => {
    console.log(`[discovery-worker:${name}] completed ${job.id}`);
  });
  worker.on('failed', (job, err) => {
    console.error(`[discovery-worker:${name}] failed ${job?.id}`, err);
  });
}

if (require.main === module) {
  startDiscoveryWorkers();
  console.log('Discovery workers started');
}
