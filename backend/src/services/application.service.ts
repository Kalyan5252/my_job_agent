import { ApplyWorkflow } from '../workflows/apply.workflow';
import { ApplicationRunOptions, ApplicationRunResult, JobProfile, ScoredJob } from '../types';
import { ManualReviewItem, ManualReviewService } from './manualReview.service';

export interface ApplicationOutcome {
  success: boolean;
  mode: 'dry-run' | 'submit';
  result: ApplicationRunResult;
  manualReview: ManualReviewItem | null;
}

/** Runs one application and records a human-review item when it gets blocked. */
export class ApplicationService {
  constructor(
    private readonly apply = new ApplyWorkflow(),
    private readonly manualReviews = new ManualReviewService(),
  ) {}

  async run(
    job: ScoredJob,
    profile: JobProfile,
    options: ApplicationRunOptions = {},
  ): Promise<ApplicationOutcome> {
    const result = await this.apply.run({ job, profile, options });
    const manualReview = await this.manualReviews
      .createFromApplicationResult(job, result, options)
      .catch((error) => {
        console.error('[application] failed to record manual review', error);
        return null;
      });
    return {
      success: result.status === 'applied' || result.status === 'draft_filled',
      mode: options.mode ?? 'dry-run',
      result,
      manualReview,
    };
  }
}
