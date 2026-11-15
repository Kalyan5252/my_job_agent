import { Queue } from 'bullmq';
import {
  DiscoveryScoreTask,
  DiscoveryScrapeTask,
  DiscoveryWriteTask,
} from '../pipeline/discovery.types';
import { DiscoveryTaskDispatcher } from '../pipeline/discovery.dispatcher';
import { getRedisConnection, isRedisEnabled } from './apply.queue';
import { JobSearchPriority } from '../types';

export const DISCOVERY_SCRAPE_QUEUE_NAME = 'discovery-scrape';
export const DISCOVERY_SCORE_QUEUE_NAME = 'discovery-score';
export const DISCOVERY_WRITE_QUEUE_NAME = 'discovery-write';

let scrapeQueue: Queue<DiscoveryScrapeTask> | null = null;
let scoreQueue: Queue<DiscoveryScoreTask> | null = null;
let writeQueue: Queue<DiscoveryWriteTask> | null = null;

function queueOptions(jobId: string, priority = 3) {
  return {
    jobId,
    priority,
    attempts: 3,
    backoff: { type: 'exponential' as const, delay: 3_000 },
    removeOnComplete: 200,
    removeOnFail: 500,
  };
}

export function getDiscoveryScrapeQueue(): Queue<DiscoveryScrapeTask> {
  if (!isRedisEnabled()) {
    throw new Error('Redis is disabled. Set REDIS_ENABLED=true to use discovery queues.');
  }
  if (!scrapeQueue) {
    scrapeQueue = new Queue(DISCOVERY_SCRAPE_QUEUE_NAME, {
      connection: getRedisConnection(),
    });
  }
  return scrapeQueue;
}

export function getDiscoveryScoreQueue(): Queue<DiscoveryScoreTask> {
  if (!isRedisEnabled()) {
    throw new Error('Redis is disabled. Set REDIS_ENABLED=true to use discovery queues.');
  }
  if (!scoreQueue) {
    scoreQueue = new Queue(DISCOVERY_SCORE_QUEUE_NAME, {
      connection: getRedisConnection(),
    });
  }
  return scoreQueue;
}

export function getDiscoveryWriteQueue(): Queue<DiscoveryWriteTask> {
  if (!isRedisEnabled()) {
    throw new Error('Redis is disabled. Set REDIS_ENABLED=true to use discovery queues.');
  }
  if (!writeQueue) {
    writeQueue = new Queue(DISCOVERY_WRITE_QUEUE_NAME, {
      connection: getRedisConnection(),
    });
  }
  return writeQueue;
}

export class BullDiscoveryTaskDispatcher implements DiscoveryTaskDispatcher {
  async dispatchScrape(task: DiscoveryScrapeTask): Promise<void> {
    await getDiscoveryScrapeQueue().add(
      'scrape',
      task,
      queueOptions(`scrape:${task.runId}`, discoveryPriority(task.searchQuery?.priority)),
    );
  }

  async dispatchScore(task: DiscoveryScoreTask): Promise<void> {
    await getDiscoveryScoreQueue().add('score', task, queueOptions(`score:${task.runId}`, 2));
  }

  async dispatchWrite(task: DiscoveryWriteTask): Promise<void> {
    await getDiscoveryWriteQueue().add('write', task, queueOptions(`write:${task.runId}`, 1));
  }
}

function discoveryPriority(priority?: JobSearchPriority): number {
  if (!priority) return 3;
  if (priority.highPayFirst) return 1;
  if (priority.companyTierOrder?.[0] === 'top') return 2;
  return 3;
}
