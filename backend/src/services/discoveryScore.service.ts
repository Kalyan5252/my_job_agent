import { env } from '../config/env';
import { DiscoveryScoreStageResult, DiscoveryPipelineContext } from '../pipeline/discovery.types';
import { isOpenRouterRateLimitError, LLMService, OpenRouterRateLimitError } from './llm.service';
import { ScoringService } from './scoring.service';
import { JobPosting, JobProfile, ScoredJob } from '../types';

const MAX_RATE_LIMIT_ATTEMPTS = 3;

/**
 * Scores jobs with bounded concurrency. Rate-limited items are retried with
 * backoff; anything that still cannot be scored gets a keyword score and is
 * NOT recommended for applying (apply=false) so failures never trigger submits.
 */
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
    const { scored, fallbackCount } = await this.scoreJobs(context.profile, jobs);
    const findings = [...diagnostics.findings];
    if (fallbackCount > 0) {
      findings.push({
        stage: 'result',
        severity: 'warning',
        code: 'SCORING_FALLBACK_USED',
        message: `${fallbackCount} job(s) could not be scored by the LLM; keyword score used and apply=false.`,
        meta: { fallbackCount },
      });
    }
    return {
      context,
      jobs: scored,
      diagnostics: { counts: diagnostics.counts, findings },
    };
  }

  private async scoreJobs(profile: JobProfile, jobs: JobPosting[]) {
    const results: ScoredJob[] = new Array(jobs.length);
    let fallbackCount = 0;
    let queue = jobs.map((job, index) => ({ job, index, attempts: 0 }));
    let batchSize = Math.max(1, env.DISCOVERY_SCORE_RATE_LIMIT_BATCH_SIZE);

    while (queue.length > 0) {
      const batch = queue.slice(0, batchSize);
      queue = queue.slice(batchSize);
      const settled = await Promise.allSettled(
        batch.map(({ job }) => this.scoring.scoreAndDecide(profile, job)),
      );

      const retry: typeof batch = [];
      let retryAfterMs: number | undefined;

      settled.forEach((result, offset) => {
        const item = batch[offset];
        if (result.status === 'fulfilled') {
          results[item.index] = result.value;
          return;
        }

        if (
          isOpenRouterRateLimitError(result.reason) &&
          item.attempts + 1 < MAX_RATE_LIMIT_ATTEMPTS
        ) {
          retry.push({ ...item, attempts: item.attempts + 1 });
          retryAfterMs = Math.max(
            retryAfterMs ?? 0,
            (result.reason as OpenRouterRateLimitError).retryAfterMs ?? 0,
          );
          return;
        }

        fallbackCount += 1;
        results[item.index] = this.fallback(profile, item.job, result.reason);
      });

      if (retry.length > 0) {
        queue = [...retry, ...queue];
        batchSize = Math.max(1, Math.ceil(batchSize / 2));
        await sleep(Math.max(retryAfterMs ?? 0, env.DISCOVERY_SCORE_BATCH_DELAY_MS));
      } else if (queue.length > 0) {
        await sleep(env.DISCOVERY_SCORE_BATCH_DELAY_MS);
      }
    }

    return { scored: results.filter(Boolean), fallbackCount };
  }

  private fallback(profile: JobProfile, job: JobPosting, reason: unknown): ScoredJob {
    const rateLimited = isOpenRouterRateLimitError(reason);
    const detail = rateLimited
      ? 'llm rate limited'
      : `scoring failed: ${reason instanceof Error ? reason.message : String(reason)}`.slice(
          0,
          160,
        );
    return {
      ...job,
      score: this.llm.keywordScore(profile, `${job.title} ${job.description}`),
      apply: false,
      reasoning: `fallback keyword score (${detail}); not auto-recommended`,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
