import { Queue } from 'bullmq';
import { COMPANY_CAREER_SOURCES } from '../config/companySources';
import {
  DISCOVERY_SCORE_QUEUE_NAME,
  DISCOVERY_SCRAPE_QUEUE_NAME,
  DISCOVERY_WRITE_QUEUE_NAME,
} from '../queues/discovery.queue';
import { APPLY_QUEUE_NAME, getRedisConnection, isRedisEnabled } from '../queues/apply.queue';
import { ManualReviewService } from './manualReview.service';

interface QueueSnapshot {
  name: string;
  enabled: boolean;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
}

export class DashboardService {
  constructor(private readonly manualReviews = new ManualReviewService()) {}

  async snapshot() {
    const queues = await this.queueSnapshots();
    const reviews = await this.manualReviews.list();
    const sourceCount = COMPANY_CAREER_SOURCES.filter((source) => source.enabled).length;

    return {
      generatedAt: new Date().toISOString(),
      sources: {
        configured: COMPANY_CAREER_SOURCES.length,
        enabled: sourceCount,
        targetMet: sourceCount >= 30,
        providers: providerBreakdown(),
      },
      queues,
      workers: {
        redisEnabled: isRedisEnabled(),
        scrapeQueue: DISCOVERY_SCRAPE_QUEUE_NAME,
        scoreQueue: DISCOVERY_SCORE_QUEUE_NAME,
        writeQueue: DISCOVERY_WRITE_QUEUE_NAME,
      },
      reliability: {
        retries: 'BullMQ attempts=3 with exponential backoff',
        manualReviewOpen: reviews.filter((item) => item.status !== 'resolved').length,
        manualReviewTotal: reviews.length,
      },
      manualReviews: reviews.slice(0, 20),
    };
  }

  private async queueSnapshots(): Promise<QueueSnapshot[]> {
    const names = [
      APPLY_QUEUE_NAME,
      DISCOVERY_SCRAPE_QUEUE_NAME,
      DISCOVERY_SCORE_QUEUE_NAME,
      DISCOVERY_WRITE_QUEUE_NAME,
    ];

    if (!isRedisEnabled()) {
      return names.map((name) => emptyQueue(name, false));
    }

    const connection = getRedisConnection();
    const queues = names.map((name) => new Queue(name, { connection }));

    try {
      return await Promise.all(
        queues.map(async (queue) => {
          const counts = await queue.getJobCounts(
            'waiting',
            'active',
            'completed',
            'failed',
            'delayed',
            'paused',
          );
          return {
            name: queue.name,
            enabled: true,
            waiting: counts.waiting || 0,
            active: counts.active || 0,
            completed: counts.completed || 0,
            failed: counts.failed || 0,
            delayed: counts.delayed || 0,
            paused: counts.paused || 0,
          };
        }),
      );
    } finally {
      await Promise.allSettled(queues.map((queue) => queue.close()));
    }
  }
}

function emptyQueue(name: string, enabled: boolean): QueueSnapshot {
  return {
    name,
    enabled,
    waiting: 0,
    active: 0,
    completed: 0,
    failed: 0,
    delayed: 0,
    paused: 0,
  };
}

function providerBreakdown(): Record<string, number> {
  return COMPANY_CAREER_SOURCES.reduce<Record<string, number>>((acc, source) => {
    acc[source.provider] = (acc[source.provider] || 0) + 1;
    return acc;
  }, {});
}
