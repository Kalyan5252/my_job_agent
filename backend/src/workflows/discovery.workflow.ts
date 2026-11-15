import { BullDiscoveryTaskDispatcher } from '../queues/discovery.queue';
import { isRedisEnabled } from '../queues/apply.queue';
import { HttpError } from '../lib/httpError';
import {
  DiscoveryCompletedRunResult,
  DiscoveryPipelineResult,
  DiscoveryPipelineContext,
} from '../pipeline/discovery.types';
import { DiscoverySchedulerService } from '../services/discoveryScheduler.service';
import { DiscoveryScrapeService } from '../services/discoveryScrape.service';
import { DiscoveryScoreService } from '../services/discoveryScore.service';
import { DiscoveryWriteService } from '../services/discoveryWrite.service';
import { JobProfile, JobSearchQuery } from '../types';

export class DiscoveryWorkflow {
  private readonly scrape: DiscoveryScrapeService;
  private readonly score: DiscoveryScoreService;
  private readonly write: DiscoveryWriteService;
  private readonly scheduler: DiscoverySchedulerService;

  constructor(options?: {
    scrape?: DiscoveryScrapeService;
    score?: DiscoveryScoreService;
    write?: DiscoveryWriteService;
    scheduler?: DiscoverySchedulerService;
  }) {
    this.scrape = options?.scrape ?? new DiscoveryScrapeService();
    this.score = options?.score ?? new DiscoveryScoreService();
    this.write = options?.write ?? new DiscoveryWriteService();
    this.scheduler =
      options?.scheduler ?? new DiscoverySchedulerService(new BullDiscoveryTaskDispatcher());
  }

  async run(
    profile: JobProfile,
    searchQuery?: Partial<JobSearchQuery>,
  ): Promise<DiscoveryCompletedRunResult> {
    const context: DiscoveryPipelineContext = {
      runId: createDiscoveryRunId(),
      profile,
      searchQuery,
      queuedAt: new Date().toISOString(),
    };
    const scraped = await this.scrape.run(context);
    const scored = await this.score.run(scraped.context, scraped.jobs, scraped.diagnostics);
    const written = await this.write.run(scored.context, scored.jobs, scored.diagnostics);
    return this.write.toCompletedResult(written);
  }

  async schedule(
    profile: JobProfile,
    searchQuery?: Partial<JobSearchQuery>,
  ): Promise<DiscoveryPipelineResult> {
    if (!isRedisEnabled()) {
      throw new HttpError(
        409,
        'Scheduling needs Redis (REDIS_ENABLED=true). Use POST /workflows/discovery/run instead.',
      );
    }
    return this.scheduler.schedule(profile, searchQuery);
  }
}

function createDiscoveryRunId(): string {
  return `discovery-inline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
