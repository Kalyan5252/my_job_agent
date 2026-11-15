import { DiscoveryTaskDispatcher } from '../pipeline/discovery.dispatcher';
import { DiscoveryQueuedRunResult, DiscoveryScrapeTask } from '../pipeline/discovery.types';
import { JobProfile, JobSearchQuery } from '../types';

export class DiscoverySchedulerService {
  constructor(private readonly dispatcher: DiscoveryTaskDispatcher) {}

  async schedule(
    profile: JobProfile,
    searchQuery?: Partial<JobSearchQuery>,
  ): Promise<DiscoveryQueuedRunResult> {
    const queuedAt = new Date().toISOString();
    const task: DiscoveryScrapeTask = {
      runId: createDiscoveryRunId(),
      profile,
      searchQuery,
      queuedAt,
    };

    await this.dispatcher.dispatchScrape(task);
    return {
      runId: task.runId,
      status: 'queued',
      queuedAt,
    };
  }
}

function createDiscoveryRunId(): string {
  return `discovery-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
