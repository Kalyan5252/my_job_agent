import test from 'node:test';
import assert from 'node:assert/strict';
import { DiscoverySchedulerService } from '../src/services/discoveryScheduler.service';
import { InMemoryPipelineEventBus } from '../src/pipeline/eventBus';
import {
  DiscoveryScoreProcessor,
  DiscoveryScrapeProcessor,
  DiscoveryWriteProcessor,
} from '../src/pipeline/discovery.processors';
import {
  DiscoveryCompletedRunResult,
  DiscoveryScoreTask,
  DiscoveryScrapeTask,
  DiscoveryWriteTask,
} from '../src/pipeline/discovery.types';
import { DiscoveryDiagnostics, JobPosting, ScoredJob } from '../src/types';

test('queued discovery pipeline runs end to end from scheduler to final persisted result', async () => {
  const dispatcher = new DrainableDispatcher();
  const events = new InMemoryPipelineEventBus();
  const diagnostics = emptyDiagnostics();
  const writes: ScoredJob[][] = [];

  const scrapeProcessor = new DiscoveryScrapeProcessor(
    {
      run: async (context: DiscoveryScrapeTask) => ({
        context,
        jobs: [
          {
            source: 'company-openai',
            externalId: 'openai-1',
            title: 'Software Engineer',
            company: 'OpenAI',
            description: 'platform team',
            applyUrl: 'https://openai.com/careers/1',
          },
        ] satisfies JobPosting[],
        diagnostics,
      }),
    } as never,
    dispatcher,
    events,
  );
  const scoreProcessor = new DiscoveryScoreProcessor(
    {
      run: async (context: DiscoveryScoreTask) => ({
        context,
        jobs: context.jobs.map(
          (job) =>
            ({
              ...job,
              score: 95,
              apply: true,
              reasoning: 'excellent fit',
            }) satisfies ScoredJob,
        ),
        diagnostics: context.diagnostics,
      }),
    } as never,
    dispatcher,
    events,
  );
  const writeProcessor = new DiscoveryWriteProcessor(
    {
      run: async (context: DiscoveryWriteTask) => {
        writes.push(context.jobs);
        return {
          context,
          jobs: context.jobs,
          diagnostics: {
            ...context.diagnostics,
            counts: {
              ...context.diagnostics.counts,
              persistedJobs: context.jobs.length,
              newJobs: context.jobs.length,
              existingJobs: 0,
              duplicateInputJobs: 0,
            },
          },
          export: { status: 'skipped', target: 'google-sheets', rowCount: context.jobs.length },
        };
      },
      toCompletedResult: (result: {
        context: DiscoveryWriteTask;
        jobs: ScoredJob[];
        diagnostics: DiscoveryDiagnostics;
        export: { status: 'skipped'; target: 'google-sheets'; rowCount: number };
      }) =>
        ({
          runId: result.context.runId,
          status: 'completed',
          total: result.jobs.length,
          applyCount: result.jobs.filter((job) => job.apply).length,
          jobs: result.jobs,
          diagnostics: result.diagnostics,
          export: result.export,
        }) satisfies DiscoveryCompletedRunResult,
    } as never,
    events,
  );

  dispatcher.connect({ scrapeProcessor, scoreProcessor, writeProcessor });

  const scheduler = new DiscoverySchedulerService(dispatcher);
  const queued = await scheduler.schedule(
    { role: 'Software Engineer', skills: ['TypeScript'], experience: 'junior' },
    { role: 'Software Engineer', maxResults: 10 },
  );

  assert.equal(queued.status, 'queued');
  const completed = await dispatcher.drainAll();

  assert.ok(completed);
  assert.equal(completed?.runId, queued.runId);
  assert.equal(completed?.total, 1);
  assert.equal(writes.length, 1);
  assert.deepEqual(
    events.events.map((event) => event.type),
    ['job.scraped', 'job.scored', 'job.persisted'],
  );
});

class DrainableDispatcher {
  private readonly scrapeTasks: DiscoveryScrapeTask[] = [];
  private readonly scoreTasks: DiscoveryScoreTask[] = [];
  private readonly writeTasks: DiscoveryWriteTask[] = [];
  private processors:
    | {
        scrapeProcessor: DiscoveryScrapeProcessor;
        scoreProcessor: DiscoveryScoreProcessor;
        writeProcessor: DiscoveryWriteProcessor;
      }
    | undefined;

  connect(processors: {
    scrapeProcessor: DiscoveryScrapeProcessor;
    scoreProcessor: DiscoveryScoreProcessor;
    writeProcessor: DiscoveryWriteProcessor;
  }): void {
    this.processors = processors;
  }

  async dispatchScrape(task: DiscoveryScrapeTask): Promise<void> {
    this.scrapeTasks.push(task);
  }

  async dispatchScore(task: DiscoveryScoreTask): Promise<void> {
    this.scoreTasks.push(task);
  }

  async dispatchWrite(task: DiscoveryWriteTask): Promise<void> {
    this.writeTasks.push(task);
  }

  async drainAll(): Promise<DiscoveryCompletedRunResult | undefined> {
    if (!this.processors) throw new Error('processors not connected');

    while (this.scrapeTasks.length > 0) {
      await this.processors.scrapeProcessor.process(this.scrapeTasks.shift()!);
    }
    while (this.scoreTasks.length > 0) {
      await this.processors.scoreProcessor.process(this.scoreTasks.shift()!);
    }
    while (this.writeTasks.length > 0) {
      return this.processors.writeProcessor.process(this.writeTasks.shift()!);
    }
    return undefined;
  }
}

function emptyDiagnostics(): DiscoveryDiagnostics {
  return {
    counts: {
      apiJobs: 0,
      indianJobs: 0,
      htmlJobs: 0,
      browserJobs: 0,
      mergedJobs: 0,
      actionableJobs: 0,
      skillAlignedJobs: 0,
      candidateJobs: 0,
      experienceAlignedJobs: 0,
      prioritizedJobs: 0,
    },
    findings: [],
  };
}
