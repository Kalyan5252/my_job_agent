import { DiscoveryTaskDispatcher } from './discovery.dispatcher';
import { PipelineEventBus } from './eventBus';
import {
  DiscoveryCompletedRunResult,
  DiscoveryScoreTask,
  DiscoveryScrapeTask,
  DiscoveryWriteTask,
} from './discovery.types';
import { DiscoveryScrapeService } from '../services/discoveryScrape.service';
import { DiscoveryScoreService } from '../services/discoveryScore.service';
import { DiscoveryWriteService } from '../services/discoveryWrite.service';

export class DiscoveryScrapeProcessor {
  constructor(
    private readonly service: DiscoveryScrapeService,
    private readonly dispatcher: DiscoveryTaskDispatcher,
    private readonly eventBus: PipelineEventBus,
  ) {}

  async process(task: DiscoveryScrapeTask): Promise<void> {
    const result = await this.service.run(task);
    await this.eventBus.emit({
      type: 'job.scraped',
      emittedAt: new Date().toISOString(),
      payload: {
        runId: task.runId,
        jobs: result.jobs.length,
      },
    });
    await this.dispatcher.dispatchScore({
      ...result.context,
      jobs: result.jobs,
      diagnostics: result.diagnostics,
    });
  }
}

export class DiscoveryScoreProcessor {
  constructor(
    private readonly service: DiscoveryScoreService,
    private readonly dispatcher: DiscoveryTaskDispatcher,
    private readonly eventBus: PipelineEventBus,
  ) {}

  async process(task: DiscoveryScoreTask): Promise<void> {
    const result = await this.service.run(task, task.jobs, task.diagnostics);
    await this.eventBus.emit({
      type: 'job.scored',
      emittedAt: new Date().toISOString(),
      payload: {
        runId: task.runId,
        jobs: result.jobs.length,
      },
    });
    await this.dispatcher.dispatchWrite({
      ...result.context,
      jobs: result.jobs,
      diagnostics: result.diagnostics,
    });
  }
}

export class DiscoveryWriteProcessor {
  constructor(
    private readonly service: DiscoveryWriteService,
    private readonly eventBus: PipelineEventBus,
  ) {}

  async process(task: DiscoveryWriteTask): Promise<DiscoveryCompletedRunResult> {
    const result = await this.service.run(task, task.jobs, task.diagnostics);
    const completed = this.service.toCompletedResult(result);
    await this.eventBus.emit({
      type: 'job.persisted',
      emittedAt: new Date().toISOString(),
      payload: {
        runId: task.runId,
        jobs: result.jobs.length,
        newJobs: result.diagnostics.counts.newJobs ?? 0,
      },
    });
    return completed;
  }
}
