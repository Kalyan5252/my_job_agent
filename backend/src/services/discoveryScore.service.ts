import { env } from '../config/env';
import { DiscoveryScoreStageResult, DiscoveryPipelineContext } from '../pipeline/discovery.types';
import { OpenRouterRateLimitError, isOpenRouterRateLimitError, LLMService } from './llm.service';
import { ScoringService } from './scoring.service';
import { JobPosting, ScoredJob } from '../types';

export class DiscoveryScoreService {
  private readonly llm: LLMService;
  private readonly scoring: ScoringService;

  constructor(llm = new LLMService()) {
    this.llm = llm;
    this.scoring = new ScoringService(this.llm);
  }

  async run(
    context: DiscoveryPipelineContext,
    jobs: JobPosting[],
    diagnostics: DiscoveryScoreStageResult['diagnostics'],
  ): Promise<DiscoveryScoreStageResult> {
    const scoredJobs = await this.scoreJobs(context.profile, jobs);
    return {
      context,
      jobs: scoredJobs,
      diagnostics,
    };
  }

  private async scoreJobs(profile: DiscoveryPipelineContext['profile'], jobs: JobPosting[]) {
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
