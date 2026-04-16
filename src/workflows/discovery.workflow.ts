import { JobHunterAgent } from "../agents/jobHunter.agent";
import { JobProfile } from "../types";

export class DiscoveryWorkflow {
  private readonly hunter = new JobHunterAgent();

  async run(profile: JobProfile) {
    const jobs = await this.hunter.run(profile);
    return {
      total: jobs.length,
      applyCount: jobs.filter((job) => job.apply).length,
      jobs
    };
  }
}
