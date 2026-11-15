import { env } from '../config/env';
import { JobPosting, JobSearchQuery } from '../types';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ApifyActorConfig {
  actorId: string;
  source: string;
}

export interface ApifySourceDiagnostic {
  actorId: string;
  fetched: number;
  accepted: number;
  error?: string;
}

export interface ApifySourceResult {
  jobs: JobPosting[];
  diagnostics: ApifySourceDiagnostic[];
}

export interface ApifySourceOptions {
  enabled?: boolean;
  token?: string;
  timeoutSecs?: number;
}

interface ApifyJobItem {
  id?: string | number;
  jobId?: string | number;
  job_id?: string | number;
  url?: string;
  applyUrl?: string;
  apply_url?: string;
  jobUrl?: string;
  title?: string;
  jobTitle?: string;
  positionName?: string;
  company?: string;
  companyName?: string;
  employer?: string;
  location?: string;
  jobLocation?: string;
  description?: string;
  jobDescription?: string;
  text?: string;
  requirements?: string[] | string;
}

export class ApifySource {
  constructor(
    private readonly actors: ApifyActorConfig[] = defaultActors(),
    private readonly fetcher: FetchLike = fetch,
    private readonly options: ApifySourceOptions = {},
  ) {}

  isEnabled(): boolean {
    const enabled = this.options.enabled ?? env.APIFY_ENABLED;
    const token = this.options.token ?? env.APIFY_TOKEN;
    return enabled && Boolean(token) && this.actors.length > 0;
  }

  async fetchJobs(query: JobSearchQuery): Promise<ApifySourceResult> {
    if (!this.isEnabled()) {
      return { jobs: [], diagnostics: [] };
    }

    const results = await Promise.all(this.actors.map((actor) => this.fetchActor(actor, query)));
    return {
      jobs: results.flatMap((result) => result.jobs),
      diagnostics: results.map((result) => result.diagnostic),
    };
  }

  private async fetchActor(
    actor: ApifyActorConfig,
    query: JobSearchQuery,
  ): Promise<{ jobs: JobPosting[]; diagnostic: ApifySourceDiagnostic }> {
    try {
      const items = await this.runActor(actor.actorId, query);
      const jobs = items
        .map((item, index) => this.normalizeItem(actor, item, index))
        .filter((job): job is JobPosting => Boolean(job))
        .filter((job) => this.isRelevant(job, query))
        .slice(0, query.maxResults ?? 50);

      return {
        jobs,
        diagnostic: {
          actorId: actor.actorId,
          fetched: items.length,
          accepted: jobs.length,
        },
      };
    } catch (error) {
      return {
        jobs: [],
        diagnostic: {
          actorId: actor.actorId,
          fetched: 0,
          accepted: 0,
          error: error instanceof Error ? error.message : 'unknown Apify source error',
        },
      };
    }
  }

  private async runActor(actorId: string, query: JobSearchQuery): Promise<ApifyJobItem[]> {
    const timeoutSecs = this.options.timeoutSecs ?? env.APIFY_TIMEOUT_SECS;
    const url = new URL(
      `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items`,
    );
    url.searchParams.set('token', this.options.token ?? env.APIFY_TOKEN ?? '');
    url.searchParams.set('timeout', String(timeoutSecs));
    url.searchParams.set('memory', '1024');

    const response = await this.fetcher(url.toString(), {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(this.actorInput(query)),
      signal: AbortSignal.timeout((timeoutSecs + 10) * 1000),
    });

    if (!response.ok) {
      throw new Error(`Apify actor request failed ${response.status}`);
    }

    const data = (await response.json()) as unknown;
    if (!Array.isArray(data)) return [];
    return data.filter((item): item is ApifyJobItem => Boolean(item) && typeof item === 'object');
  }

  private actorInput(query: JobSearchQuery): Record<string, unknown> {
    return {
      query: query.role,
      search: query.role,
      searchTerms: [query.role, ...(query.skills || []).slice(0, 5)],
      location: query.location || query.filters?.locations?.[0] || query.filters?.country,
      country: query.filters?.country,
      maxItems: query.maxResults ?? 50,
      maxResults: query.maxResults ?? 50,
    };
  }

  private normalizeItem(
    actor: ApifyActorConfig,
    item: ApifyJobItem,
    index: number,
  ): JobPosting | null {
    const title = text(item.title || item.jobTitle || item.positionName);
    const company = text(item.company || item.companyName || item.employer);
    const applyUrl = text(item.applyUrl || item.apply_url || item.jobUrl || item.url);
    const description = text(item.description || item.jobDescription || item.text || title);
    if (!title || !company || !applyUrl) return null;

    return {
      source: actor.source,
      externalId: `apify-${slugify(actor.actorId)}-${text(item.id || item.jobId || item.job_id) || index}-${slugify(`${company}-${title}`)}`,
      title,
      company,
      location: text(item.location || item.jobLocation) || 'Not specified',
      description,
      requirements: normalizeRequirements(item.requirements, description),
      applyUrl,
      rawData: {
        provider: 'apify',
        actorId: actor.actorId,
        item,
      },
    };
  }

  private isRelevant(job: JobPosting, query: JobSearchQuery): boolean {
    const haystack =
      `${job.title} ${job.description} ${(job.requirements || []).join(' ')}`.toLowerCase();
    const tokens = [query.role, ...(query.skills || [])]
      .flatMap((value) => value.toLowerCase().split(/[^a-z0-9+#.]+/g))
      .filter((token) => token.length >= 3);
    return tokens.length === 0 || tokens.some((token) => haystack.includes(token));
  }
}

function defaultActors(): ApifyActorConfig[] {
  return env.APIFY_ACTORS.split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((actorId) => ({
      actorId,
      source: `apify-${slugify(actorId)}`,
    }));
}

function normalizeRequirements(value: ApifyJobItem['requirements'], description: string): string[] {
  if (Array.isArray(value)) return value.map(text).filter(Boolean).slice(0, 10);
  if (typeof value === 'string') return [value].map(text).filter(Boolean);

  const lower = description.toLowerCase();
  return [
    'typescript',
    'javascript',
    'node',
    'python',
    'java',
    'go',
    'react',
    'aws',
    'gcp',
    'kubernetes',
    'postgres',
    'mongodb',
    'redis',
  ].filter((keyword) => lower.includes(keyword));
}

function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}
