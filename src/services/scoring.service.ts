import { LLMService } from "./llm.service";
import { JobPosting, JobProfile, ScoredJob } from "../types";

export class ScoringService {
  constructor(private readonly llm: LLMService) {}

  async scoreAndDecide(profile: JobProfile, job: JobPosting): Promise<ScoredJob> {
    const { score, reasoning } = await this.llm.scoreJob(profile, job);
    const apply = await this.llm.decideApply(score, reasoning);

    return {
      ...job,
      score,
      apply,
      reasoning
    };
  }
}
