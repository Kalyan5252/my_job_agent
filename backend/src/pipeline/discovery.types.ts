import {
  DiscoveryDiagnostics,
  DiscoveryExportMetadata,
  DiscoveryRunResult,
  JobPosting,
  JobProfile,
  JobSearchQuery,
  ScoredJob,
} from '../types';

export interface DiscoveryPipelineContext {
  runId: string;
  profile: JobProfile;
  searchQuery?: Partial<JobSearchQuery>;
  queuedAt: string;
}

export interface DiscoveryScrapeTask extends DiscoveryPipelineContext {}

export interface DiscoveryScoreTask extends DiscoveryPipelineContext {
  jobs: JobPosting[];
  diagnostics: DiscoveryDiagnostics;
}

export interface DiscoveryWriteTask extends DiscoveryPipelineContext {
  jobs: ScoredJob[];
  diagnostics: DiscoveryDiagnostics;
}

export interface DiscoveryScrapeStageResult {
  context: DiscoveryPipelineContext;
  jobs: JobPosting[];
  diagnostics: DiscoveryDiagnostics;
}

export interface DiscoveryScoreStageResult {
  context: DiscoveryPipelineContext;
  jobs: ScoredJob[];
  diagnostics: DiscoveryDiagnostics;
}

export interface DiscoveryWriteStageResult {
  context: DiscoveryPipelineContext;
  jobs: ScoredJob[];
  diagnostics: DiscoveryDiagnostics;
  export: DiscoveryExportMetadata;
}

export interface DiscoveryQueuedRunResult {
  runId: string;
  status: 'queued';
  queuedAt: string;
}

export interface DiscoveryCompletedRunResult extends DiscoveryRunResult {
  runId: string;
  status: 'completed';
}

export type DiscoveryPipelineResult = DiscoveryQueuedRunResult | DiscoveryCompletedRunResult;
