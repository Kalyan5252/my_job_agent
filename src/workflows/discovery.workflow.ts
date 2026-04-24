import { JobHunterAgent } from "../agents/jobHunter.agent";
import { DiscoveryRunResult, JobProfile, JobSearchQuery } from "../types";

export class DiscoveryWorkflow {
  private readonly hunter = new JobHunterAgent();

  async run(profile: JobProfile, searchQuery?: Partial<JobSearchQuery>): Promise<DiscoveryRunResult> {
    const jobs = await this.hunter.run(profile, searchQuery);

    return {
      total: jobs.length,
      applyCount: jobs.filter((job) => job.apply).length,
      jobs,
      diagnostics: {
        counts: {
          apiJobs: 0,
          indianJobs: 0,
          htmlJobs: 0,
          browserJobs: 0,
          mergedJobs: jobs.length,
          actionableJobs: jobs.filter((job) => Boolean(job.applyUrl)).length,
          skillAlignedJobs: 0,
          candidateJobs: jobs.length,
          experienceAlignedJobs: jobs.length,
          prioritizedJobs: jobs.length
        },
        findings: []
      }
    };
  }
}
