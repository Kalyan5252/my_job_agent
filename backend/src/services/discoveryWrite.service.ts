import {
  DiscoveryCompletedRunResult,
  DiscoveryPipelineContext,
  DiscoveryWriteStageResult,
} from '../pipeline/discovery.types';
import { JobRepository } from '../repositories/job.repository';
import { DiscoveryExportService } from './discoveryExport.service';
import { DiscoveryDiagnostics, ScoredJob } from '../types';

export class DiscoveryWriteService {
  constructor(
    private readonly jobs = new JobRepository(),
    private readonly exporter = new DiscoveryExportService(),
  ) {}

  async run(
    context: DiscoveryPipelineContext,
    jobs: ScoredJob[],
    diagnostics: DiscoveryDiagnostics,
  ): Promise<DiscoveryWriteStageResult> {
    const saveResult = await this.jobs.saveDiscoveryJobs(jobs, { discoveryRunId: context.runId });
    const updatedDiagnostics = this.withPersistenceDiagnostics(
      diagnostics,
      context.runId,
      saveResult.jobs.length,
      saveResult.newJobs.length,
      saveResult.existingJobs.length,
      saveResult.duplicateInputCount,
    );
    const exportResult = await this.exporter.exportDiscoveryRun({
      profile: context.profile,
      searchQuery: context.searchQuery,
      jobs: saveResult.jobs,
      diagnostics: updatedDiagnostics,
    });

    return {
      context,
      jobs: saveResult.jobs,
      diagnostics: updatedDiagnostics,
      export: exportResult,
    };
  }

  toCompletedResult(result: DiscoveryWriteStageResult): DiscoveryCompletedRunResult {
    return {
      runId: result.context.runId,
      status: 'completed',
      total: result.jobs.length,
      applyCount: result.jobs.filter((job) => job.apply).length,
      jobs: result.jobs,
      diagnostics: result.diagnostics,
      export: result.export,
    };
  }

  private withPersistenceDiagnostics(
    diagnostics: DiscoveryDiagnostics,
    runId: string,
    persistedJobs: number,
    newJobs: number,
    existingJobs: number,
    duplicateInputJobs: number,
  ): DiscoveryDiagnostics {
    return {
      counts: {
        ...diagnostics.counts,
        persistedJobs,
        newJobs,
        existingJobs,
        duplicateInputJobs,
      },
      findings: [
        ...diagnostics.findings,
        {
          stage: 'result',
          severity: 'info',
          code: 'PERSISTENCE_SUMMARY',
          message: 'Discovery jobs were upserted by source and external id.',
          meta: {
            discoveryRunId: runId,
            persistedJobs,
            newJobs,
            existingJobs,
            duplicateInputJobs,
          },
        },
      ],
    };
  }
}
