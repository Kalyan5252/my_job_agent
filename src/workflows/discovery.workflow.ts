import { JobHunterAgent } from '../agents/jobHunter.agent';
import { DiscoveryRunResult, JobProfile, JobSearchQuery } from '../types';

export class DiscoveryWorkflow {
  private readonly hunter = new JobHunterAgent();

  async run(
    profile: JobProfile,
    searchQuery?: Partial<JobSearchQuery>,
  ): Promise<DiscoveryRunResult> {
    const { jobs, diagnostics } = await this.hunter.run(profile, searchQuery);

    return {
      total: jobs.length,
      applyCount: jobs.filter((job) => job.apply).length,
      jobs,
      diagnostics,
    };
  }
}
