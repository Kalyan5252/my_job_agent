import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DiscoveryScoreProcessor,
  DiscoveryScrapeProcessor,
  DiscoveryWriteProcessor,
} from '../src/pipeline/discovery.processors';
import { InMemoryPipelineEventBus } from '../src/pipeline/eventBus';
import {
  DiscoveryScoreTask,
  DiscoveryScrapeTask,
  DiscoveryWriteTask,
} from '../src/pipeline/discovery.types';
import { DiscoveryDiagnostics, JobPosting, ScoredJob } from '../src/types';

test('discovery processors move work across scrape, score, and write stages', async () => {
  const dispatcher = new MemoryDispatcher();
  const events = new InMemoryPipelineEventBus();
  const diagnostics = emptyDiagnostics();
  const scrapedJobs: JobPosting[] = [
    {
      source: 'remotive',
      externalId: 'job-1',
      title: 'Backend Engineer',
      company: 'Acme',
      description: 'remote backend role',
      applyUrl: 'https://example.com/job-1',
    },
  ];
  const scoredJobs: ScoredJob[] = [
    {
      ...scrapedJobs[0],
      score: 91,
      apply: true,
      reasoning: 'strong fit',
    },
  ];

  const scrapeProcessor = new DiscoveryScrapeProcessor(
    {
      run: async (context: DiscoveryScrapeTask) => ({ context, jobs: scrapedJobs, diagnostics }),
    } as never,
    dispatcher,
    events,
  );
  const scoreProcessor = new DiscoveryScoreProcessor(
    {
      run: async (context: DiscoveryScoreTask) => ({
        context,
        jobs: scoredJobs,
        diagnostics: context.diagnostics,
      }),
    } as never,
    dispatcher,
    events,
  );
  const writeProcessor = new DiscoveryWriteProcessor(
    {
      run: async (context: DiscoveryWriteTask) => ({
        context,
        jobs: context.jobs,
        diagnostics: context.diagnostics,
        export: { status: 'skipped', target: 'google-sheets', rowCount: context.jobs.length },
      }),
      toCompletedResult: (result: {
        context: DiscoveryWriteTask;
        jobs: ScoredJob[];
        diagnostics: DiscoveryDiagnostics;
        export: { status: 'skipped'; target: 'google-sheets'; rowCount: number };
      }) => ({
        runId: result.context.runId,
        status: 'completed' as const,
        total: result.jobs.length,
        applyCount: result.jobs.filter((job) => job.apply).length,
        jobs: result.jobs,
        diagnostics: result.diagnostics,
        export: result.export,
      }),
    } as never,
    events,
  );

  await scrapeProcessor.process({
    runId: 'run-1',
    profile: { role: 'Backend Engineer', skills: ['TypeScript'], experience: 'junior' },
    searchQuery: { role: 'Backend Engineer' },
    queuedAt: '2026-07-01T00:00:00.000Z',
  });
  assert.equal(dispatcher.scoreTasks.length, 1);

  await scoreProcessor.process(dispatcher.scoreTasks.shift()!);
  assert.equal(dispatcher.writeTasks.length, 1);

  const completed = await writeProcessor.process(dispatcher.writeTasks.shift()!);
  assert.equal(completed.total, 1);
  assert.equal(completed.applyCount, 1);
  assert.deepEqual(
    events.events.map((event) => event.type),
    ['job.scraped', 'job.scored', 'job.persisted'],
  );
});

class MemoryDispatcher {
  readonly scrapeTasks: DiscoveryScrapeTask[] = [];
  readonly scoreTasks: DiscoveryScoreTask[] = [];
  readonly writeTasks: DiscoveryWriteTask[] = [];

  async dispatchScrape(task: DiscoveryScrapeTask): Promise<void> {
    this.scrapeTasks.push(task);
  }

  async dispatchScore(task: DiscoveryScoreTask): Promise<void> {
    this.scoreTasks.push(task);
  }

  async dispatchWrite(task: DiscoveryWriteTask): Promise<void> {
    this.writeTasks.push(task);
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
