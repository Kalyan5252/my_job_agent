import { ApplicationAgent } from "../agents/application.agent";
import { JobProfile, ScoredJob } from "../types";

export class ApplyWorkflow {
  private readonly agent = new ApplicationAgent();

  async run(input: { job: ScoredJob; profile: JobProfile }): Promise<void> {
    await this.agent.run(input.job, input.profile);
  }
}
