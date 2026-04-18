import { ApplicationAgent } from "../agents/application.agent";
import { ApplicationRunOptions, ApplicationRunResult, JobProfile, ScoredJob } from "../types";

export class ApplyWorkflow {
  private readonly agent = new ApplicationAgent();

  async run(input: {
    job: ScoredJob;
    profile: JobProfile;
    options?: ApplicationRunOptions;
  }): Promise<ApplicationRunResult> {
    return this.agent.run(input.job, input.profile, input.options);
  }
}
