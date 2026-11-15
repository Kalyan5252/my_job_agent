import { JobHunterAgent } from '../agents/jobHunter.agent';
import { DiscoveryExportService } from '../services/discoveryExport.service';
import { DiscoveryRunResult, JobProfile, JobSearchQuery } from '../types';

export class DiscoveryWorkflow {
  private readonly hunter = new JobHunterAgent();
  private readonly exporter = new DiscoveryExportService();

  async run(
    profile: JobProfile,
    searchQuery?: Partial<JobSearchQuery>,
  ): Promise<DiscoveryRunResult> {
    const { jobs, diagnostics } = await this.hunter.run(profile, searchQuery);
    const exportResult = await this.exporter.exportDiscoveryRun({
      profile,
      searchQuery,
      jobs,
      diagnostics,
    });

    return {
      total: jobs.length,
      applyCount: jobs.filter((job) => job.apply).length,
      jobs,
      diagnostics,
      export: exportResult,
    };
  }
}
