import { jobsCollection } from '../db/mongo/client';
import { enqueueApplication } from '../queues/apply.queue';
import { env } from '../config/env';
import { LLMService } from '../services/llm.service';
import { OpenRouterRateLimitError, isOpenRouterRateLimitError } from '../services/llm.service';
import { ResumeService } from '../services/resume.service';
import { ScoringService } from '../services/scoring.service';
import { ScraperTool } from '../tools/scraper.tool';
import { DiscoveryDiagnostics, JobPosting, JobProfile, JobSearchQuery, ScoredJob } from '../types';

export class JobHunterAgent {
  private readonly scraper = new ScraperTool();
  private readonly llm = new LLMService();
  private readonly resumeService = new ResumeService();
  private readonly scoring = new ScoringService(this.llm);

  async run(
    profile: JobProfile,
    searchQuery?: Partial<JobSearchQuery>,
  ): Promise<{ jobs: ScoredJob[]; diagnostics: DiscoveryDiagnostics }> {
    const hydratedProfile = this.resumeService.hydrateProfile(profile);
    const jobs = await this.scraper.fetchJobs({
      role: searchQuery?.role || hydratedProfile.role,
      skills: searchQuery?.skills || hydratedProfile.skills,
      computedExperienceYears: hydratedProfile.computedExperienceYears,
      location: searchQuery?.location,
      filters: searchQuery?.filters,
      priority: searchQuery?.priority,
      maxResults: searchQuery?.maxResults,
    });
    const scored = await this.scoreJobs(hydratedProfile, jobs);

    const coll = await jobsCollection();
    if (scored.length > 0) {
      await coll.insertMany(scored);
    }

    const eligible = scored.filter((job) => job.apply);
    for (const job of eligible) {
      await enqueueApplication({ job, profile: hydratedProfile });
    }

    return {
      jobs: scored,
      diagnostics: this.scraper.getLastDiagnostics(),
    };
  }

  private async scoreJobs(profile: JobProfile, jobs: JobPosting[]): Promise<ScoredJob[]> {
    if (jobs.length === 0) return [];

    const results: Array<ScoredJob | undefined> = new Array(jobs.length);
    const queue = jobs.map((job, index) => ({ job, index }));
    let batchSize = queue.length;

    while (queue.length > 0) {
      const currentBatch = queue.splice(0, batchSize);
      const settled = await Promise.allSettled(
        currentBatch.map(async ({ job }) => this.scoring.scoreAndDecide(profile, job)),
      );

      const rateLimited: Array<(typeof currentBatch)[number]> = [];

      settled.forEach((result, offset) => {
        const item = currentBatch[offset];
        if (result.status === 'fulfilled') {
          results[item.index] = result.value;
          return;
        }

        if (isOpenRouterRateLimitError(result.reason)) {
          rateLimited.push(item);
          return;
        }

        results[item.index] = {
          ...item.job,
          score: 70,
          apply: true,
          reasoning: 'fallback decision (scoring failed)',
        };
      });

      if (rateLimited.length > 0) {
        if (batchSize === 1) {
          const item = rateLimited[0];
          const retryAfterMs = this.retryDelayFrom(rateLimitedErrorFrom(settled));
          await this.sleep(retryAfterMs);
          results[item.index] = {
            ...item.job,
            score: 70,
            apply: true,
            reasoning: 'fallback decision (openrouter rate limited)',
          };
        } else {
          queue.unshift(...rateLimited);
          batchSize = Math.max(
            1,
            Math.min(env.DISCOVERY_SCORE_RATE_LIMIT_BATCH_SIZE, Math.ceil(batchSize / 2)),
          );
          await this.sleep(env.DISCOVERY_SCORE_BATCH_DELAY_MS);
        }
      } else if (queue.length > 0) {
        await this.sleep(env.DISCOVERY_SCORE_BATCH_DELAY_MS);
      }
    }

    return results.filter((job): job is ScoredJob => Boolean(job));
  }

  private retryDelayFrom(error?: OpenRouterRateLimitError): number {
    return error?.retryAfterMs ?? env.DISCOVERY_SCORE_BATCH_DELAY_MS;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function rateLimitedErrorFrom(
  settled: PromiseSettledResult<ScoredJob>[],
): OpenRouterRateLimitError | undefined {
  for (const result of settled) {
    if (result.status === 'rejected' && isOpenRouterRateLimitError(result.reason)) {
      return result.reason;
    }
  }

  return undefined;
}
