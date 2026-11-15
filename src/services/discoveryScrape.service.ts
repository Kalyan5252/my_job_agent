import { ResumeService } from './resume.service';
import { ScraperTool } from '../tools/scraper.tool';
import { DiscoveryScrapeStageResult, DiscoveryPipelineContext } from '../pipeline/discovery.types';

export class DiscoveryScrapeService {
  constructor(
    private readonly scraper = new ScraperTool(),
    private readonly resumeService = new ResumeService(),
  ) {}

  async run(context: DiscoveryPipelineContext): Promise<DiscoveryScrapeStageResult> {
    const hydratedProfile = this.resumeService.hydrateProfile(context.profile);
    const jobs = await this.scraper.fetchJobs({
      role: context.searchQuery?.role || hydratedProfile.role,
      skills: context.searchQuery?.skills || hydratedProfile.skills,
      computedExperienceYears: hydratedProfile.computedExperienceYears,
      location: context.searchQuery?.location,
      filters: context.searchQuery?.filters,
      priority: context.searchQuery?.priority,
      maxResults: context.searchQuery?.maxResults,
    });

    return {
      context: {
        ...context,
        profile: hydratedProfile,
      },
      jobs,
      diagnostics: this.scraper.getLastDiagnostics(),
    };
  }
}
