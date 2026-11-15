import {
  COMPANY_CAREER_SOURCES,
  CompanyCareerSourceConfig,
} from '../config/companySources';
import { env } from '../config/env';
import { JobPosting, JobSearchQuery } from '../types';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface CompanyCareerDiagnostics {
  company: string;
  provider: string;
  fetched: number;
  accepted: number;
  error?: string;
}

export interface CompanyCareerSourceResult {
  jobs: JobPosting[];
  diagnostics: CompanyCareerDiagnostics[];
}

export class CompanyCareerSource {
  constructor(
    private readonly sources = COMPANY_CAREER_SOURCES,
    private readonly fetcher: FetchLike = fetch,
  ) {}

  async fetchJobs(query: JobSearchQuery): Promise<CompanyCareerSourceResult> {
    const enabledSources = this.sources.filter((source) => source.enabled);
    const results = await mapWithConcurrency(
      enabledSources,
      env.DISCOVERY_SOURCE_CONCURRENCY,
      async (source) => {
        await sleep(env.DISCOVERY_SOURCE_RATE_LIMIT_MS);
        return this.fetchCompany(source, query);
      },
    );

    return {
      jobs: results.flatMap((result) => result.jobs),
      diagnostics: results.map((result) => result.diagnostic),
    };
  }

  private async fetchCompany(
    source: CompanyCareerSourceConfig,
    query: JobSearchQuery,
  ): Promise<{ jobs: JobPosting[]; diagnostic: CompanyCareerDiagnostics }> {
    try {
      const rawJobs = await this.fetchProviderJobs(source, query);
      const accepted = rawJobs
        .filter((job) => this.isRelevant(job, query))
        .slice(0, query.maxResults ?? 50);

      return {
        jobs: accepted,
        diagnostic: {
          company: source.company,
          provider: source.provider,
          fetched: rawJobs.length,
          accepted: accepted.length,
        },
      };
    } catch (error) {
      return {
        jobs: [],
        diagnostic: {
          company: source.company,
          provider: source.provider,
          fetched: 0,
          accepted: 0,
          error: error instanceof Error ? error.message : 'unknown company source error',
        },
      };
    }
  }

  private async fetchProviderJobs(
    source: CompanyCareerSourceConfig,
    query: JobSearchQuery,
  ): Promise<JobPosting[]> {
    if (source.provider === 'ashby') return this.fetchAshby(source);
    if (source.provider === 'greenhouse') return this.fetchGreenhouse(source);
    if (source.provider === 'lever') return this.fetchLever(source);
    if (source.provider === 'smartrecruiters') return this.fetchSmartRecruiters(source, query);
    if (source.provider === 'workday') return this.fetchWorkday(source, query);
    if (source.provider === 'oracle-cloud') return this.fetchOracleCloud(source, query);
    if (source.provider === 'amazon-jobs') return this.fetchAmazonJobs(source, query);
    return this.fetchCustomHtml(source, query);
  }

  private async fetchAshby(source: CompanyCareerSourceConfig): Promise<JobPosting[]> {
    const board = requiredBoard(source);
    const data = await this.fetchJson<{
      jobs?: Array<{
        id?: string;
        title?: string;
        location?: string | { name?: string };
        department?: string | { name?: string };
        team?: string | { name?: string };
        jobUrl?: string;
        applicationUrl?: string;
        descriptionHtml?: string;
        descriptionPlain?: string;
      }>;
    }>(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}`);

    return (data.jobs || []).map((job) => ({
      source: source.source,
      externalId: `${source.slug}-${job.id || slugify(`${job.title}-${locationName(job.location)}`)}`,
      title: job.title || 'Untitled role',
      company: source.company,
      location: locationName(job.location) || 'Not specified',
      description: cleanText(job.descriptionPlain || job.descriptionHtml || `${job.title || ''} ${fieldName(job.department)} ${fieldName(job.team)}`),
      requirements: inferRequirements(`${job.title || ''} ${job.descriptionPlain || job.descriptionHtml || ''}`),
      applyUrl: job.applicationUrl || job.jobUrl || source.careersUrl,
      rawData: { provider: 'ashby', job },
    }));
  }

  private async fetchGreenhouse(source: CompanyCareerSourceConfig): Promise<JobPosting[]> {
    const board = requiredBoard(source);
    const data = await this.fetchJson<{
      jobs?: Array<{
        id?: number;
        title?: string;
        absolute_url?: string;
        location?: { name?: string };
        content?: string;
        departments?: Array<{ name?: string }>;
      }>;
    }>(
      `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs?content=true`,
    );

    return (data.jobs || []).map((job) => ({
      source: source.source,
      externalId: `${source.slug}-${job.id || slugify(`${job.title}-${job.location?.name}`)}`,
      title: job.title || 'Untitled role',
      company: source.company,
      location: job.location?.name || 'Not specified',
      description: cleanText(job.content || `${job.title || ''} ${(job.departments || []).map((department) => department.name).join(' ')}`),
      requirements: inferRequirements(`${job.title || ''} ${job.content || ''}`),
      applyUrl: job.absolute_url || source.careersUrl,
      rawData: { provider: 'greenhouse', job },
    }));
  }

  private async fetchLever(source: CompanyCareerSourceConfig): Promise<JobPosting[]> {
    const board = requiredBoard(source);
    const jobs = await this.fetchJson<
      Array<{
        id?: string;
        text?: string;
        hostedUrl?: string;
        applyUrl?: string;
        categories?: {
          location?: string;
          team?: string;
          commitment?: string;
        };
        descriptionPlain?: string;
        lists?: Array<{ text?: string; content?: string }>;
      }>
    >(`https://api.lever.co/v0/postings/${encodeURIComponent(board)}?mode=json`);

    return (Array.isArray(jobs) ? jobs : []).map((job) => {
      const listText = (job.lists || [])
        .map((list) => `${list.text || ''} ${list.content || ''}`)
        .join(' ');
      return {
        source: source.source,
        externalId: `${source.slug}-${job.id || slugify(`${job.text}-${job.categories?.location}`)}`,
        title: job.text || 'Untitled role',
        company: source.company,
        location: job.categories?.location || 'Not specified',
        description: cleanText(`${job.descriptionPlain || ''} ${listText}`),
        requirements: inferRequirements(`${job.text || ''} ${job.descriptionPlain || ''} ${listText}`),
        applyUrl: job.applyUrl || job.hostedUrl || source.careersUrl,
        rawData: { provider: 'lever', job },
      };
    });
  }

  private async fetchWorkday(
    source: CompanyCareerSourceConfig,
    query: JobSearchQuery,
  ): Promise<JobPosting[]> {
    if (!source.workday) return this.fetchCustomHtml(source, query);
    const url = `${source.workday.baseUrl}/wday/cxs/${source.workday.tenant}/${source.workday.site}/jobs`;
    const data = await this.fetchJson<{
      jobPostings?: Array<{
        title?: string;
        externalPath?: string;
        locationsText?: string;
        postedOn?: string;
        bulletFields?: string[];
      }>;
    }>(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        appliedFacets: {},
        limit: Math.min(query.maxResults ?? 50, 50),
        offset: 0,
        searchText: query.role,
      }),
    });

    return (data.jobPostings || []).map((job) => ({
      source: source.source,
      externalId: `${source.slug}-${slugify(job.externalPath || `${job.title}-${job.locationsText}`)}`,
      title: job.title || 'Untitled role',
      company: source.company,
      location: job.locationsText || 'Not specified',
      description: cleanText(`${job.title || ''} ${(job.bulletFields || []).join(' ')}`),
      requirements: inferRequirements(`${job.title || ''} ${(job.bulletFields || []).join(' ')}`),
      applyUrl: job.externalPath
        ? `${source.workday!.baseUrl}${job.externalPath.startsWith('/') ? '' : '/'}${job.externalPath}`
        : source.careersUrl,
      rawData: { provider: 'workday', job },
    }));
  }

  private async fetchSmartRecruiters(
    source: CompanyCareerSourceConfig,
    query: JobSearchQuery,
  ): Promise<JobPosting[]> {
    const company = requiredBoard(source);
    const data = await this.fetchJson<{
      content?: Array<{
        id?: string;
        name?: string;
        refNumber?: string;
        releasedDate?: string;
        location?: { fullLocation?: string; city?: string; country?: string; remote?: boolean };
        department?: { label?: string };
        industry?: { label?: string };
        postingUrl?: string;
      }>;
    }>(
      `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(company)}/postings?limit=${Math.min(query.maxResults ?? 50, 100)}&q=${encodeURIComponent(query.role)}`,
    );

    return (data.content || []).map((job) => ({
      source: source.source,
      externalId: `${source.slug}-${job.id || job.refNumber || slugify(`${job.name}-${job.location?.fullLocation}`)}`,
      title: job.name || 'Untitled role',
      company: source.company,
      location:
        job.location?.fullLocation ||
        [job.location?.city, job.location?.country].filter(Boolean).join(', ') ||
        (job.location?.remote ? 'Remote' : 'Not specified'),
      description: cleanText(`${job.name || ''} ${job.department?.label || ''} ${job.industry?.label || ''}`),
      requirements: inferRequirements(`${job.name || ''} ${job.department?.label || ''} ${job.industry?.label || ''}`),
      applyUrl: job.postingUrl || `${source.careersUrl}?search=${encodeURIComponent(query.role)}`,
      rawData: { provider: 'smartrecruiters', job },
    }));
  }

  private async fetchAmazonJobs(
    source: CompanyCareerSourceConfig,
    query: JobSearchQuery,
  ): Promise<JobPosting[]> {
    const data = await this.fetchJson<{
      jobs?: Array<{
        id?: string;
        title?: string;
        job_path?: string;
        location?: string;
        description?: string;
        basic_qualifications?: string;
        preferred_qualifications?: string;
      }>;
    }>(
      `https://www.amazon.jobs/en/search.json?offset=0&result_limit=${Math.min(query.maxResults ?? 50, 50)}&sort=relevant&base_query=${encodeURIComponent(query.role)}`,
    );

    return (data.jobs || []).map((job) => ({
      source: source.source,
      externalId: `${source.slug}-${job.id || slugify(`${job.title}-${job.job_path}`)}`,
      title: job.title || 'Untitled role',
      company: source.company,
      location: job.location || 'Not specified',
      description: cleanText(`${job.description || ''} ${job.basic_qualifications || ''} ${job.preferred_qualifications || ''}`),
      requirements: inferRequirements(`${job.title || ''} ${job.basic_qualifications || ''} ${job.preferred_qualifications || ''}`),
      applyUrl: job.job_path ? new URL(job.job_path, 'https://www.amazon.jobs').toString() : source.careersUrl,
      rawData: { provider: 'amazon-jobs', job },
    }));
  }

  private async fetchOracleCloud(
    source: CompanyCareerSourceConfig,
    query: JobSearchQuery,
  ): Promise<JobPosting[]> {
    if (!source.oracleCloud) return this.fetchCustomHtml(source, query);
    const data = await this.fetchJson<{
      items?: Array<{
        requisitionList?: Array<{
          Id?: string;
          Title?: string;
          PrimaryLocation?: string;
          ShortDescription?: string;
          JobFunction?: string;
        }>;
      }>;
    }>(
      `${source.oracleCloud.baseUrl}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList&finder=findReqs;siteNumber=${encodeURIComponent(source.oracleCloud.siteNumber)},keyword=${encodeURIComponent(query.role)},limit=${Math.min(query.maxResults ?? 50, 50)}`,
    );

    const jobs = data.items?.[0]?.requisitionList || [];
    return jobs.map((job) => ({
      source: source.source,
      externalId: `${source.slug}-${job.Id || slugify(`${job.Title}-${job.PrimaryLocation}`)}`,
      title: job.Title || 'Untitled role',
      company: source.company,
      location: job.PrimaryLocation || 'Not specified',
      description: cleanText(`${job.Title || ''} ${job.ShortDescription || ''} ${job.JobFunction || ''}`),
      requirements: inferRequirements(`${job.Title || ''} ${job.ShortDescription || ''} ${job.JobFunction || ''}`),
      applyUrl: `${source.careersUrl}#/en/sites/jobsearch/job/${job.Id || ''}`,
      rawData: { provider: 'oracle-cloud', job },
    }));
  }

  private async fetchCustomHtml(
    source: CompanyCareerSourceConfig,
    query: JobSearchQuery,
  ): Promise<JobPosting[]> {
    const html = await this.fetchText(source.careersUrl);
    const titleCandidates = extractJobCandidates(html, source, query);
    return titleCandidates.map((candidate, index) => ({
      source: source.source,
      externalId: `${source.slug}-${candidate.id || index}-${slugify(candidate.title)}`,
      title: candidate.title,
      company: source.company,
      location: candidate.location || 'Not specified',
      description: cleanText(candidate.description || `${candidate.title} at ${source.company}`),
      requirements: inferRequirements(candidate.description || candidate.title),
      applyUrl: candidate.url || source.careersUrl,
      rawData: { provider: 'custom-html', candidate },
    }));
  }

  private isRelevant(job: JobPosting, query: JobSearchQuery): boolean {
    const text = `${job.title} ${job.description} ${(job.requirements || []).join(' ')}`.toLowerCase();
    const roleTokens = tokenize(query.role).filter((token) => token.length >= 3);
    const skillTokens = (query.skills || []).flatMap(tokenize).filter((token) => token.length >= 3);
    const roleMatch = roleTokens.length === 0 || roleTokens.some((token) => text.includes(token));
    const skillMatch = skillTokens.length === 0 || skillTokens.some((token) => text.includes(token));
    const blocked = /(sales|account executive|legal|finance|recruiter|talent acquisition|marketing)/i.test(job.title);
    return !blocked && (roleMatch || skillMatch);
  }

  private async fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await this.fetcher(url, withTimeout(init));
    if (!response.ok) throw new Error(`request failed ${response.status} ${url}`);
    return (await response.json()) as T;
  }

  private async fetchText(url: string): Promise<string> {
    const response = await this.fetcher(url, withTimeout());
    if (!response.ok) throw new Error(`request failed ${response.status} ${url}`);
    return response.text();
  }
}

function requiredBoard(source: CompanyCareerSourceConfig): string {
  if (!source.boardToken) throw new Error(`${source.company} is missing boardToken`);
  return source.boardToken;
}

function withTimeout(init: RequestInit = {}): RequestInit {
  return {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(15_000),
    headers: {
      accept: 'application/json,text/html;q=0.9,*/*;q=0.8',
      'user-agent':
        'Mozilla/5.0 (compatible; JobAgentBot/0.1; +https://example.local/job-agent)',
      ...(init.headers || {}),
    },
  };
}

function extractJobCandidates(
  html: string,
  source: CompanyCareerSourceConfig,
  query: JobSearchQuery,
): Array<{ id?: string; title: string; url?: string; location?: string; description?: string }> {
  const out: Array<{ id?: string; title: string; url?: string; location?: string; description?: string }> = [];
  out.push(...extractJobLinks(html, source, query));
  out.push(...extractStructuredTitles(html, source, query));
  out.push(...extractHeadingTitles(html, source, query));
  return dedupeCandidates(out).slice(0, query.maxResults ?? 50);
}

function extractJobLinks(
  html: string,
  source: CompanyCareerSourceConfig,
  query: JobSearchQuery,
): Array<{ id?: string; title: string; url?: string; location?: string; description?: string }> {
  const out: Array<{ id?: string; title: string; url?: string; location?: string; description?: string }> = [];
  const linkPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = linkPattern.exec(html))) {
    const href = decodeHtml(match[1]);
    const title = cleanText(match[2]);
    if (!title || title.length < 4 || title.length > 120) continue;
    if (!looksLikeJob(title, href, query)) continue;
    out.push({
      id: slugify(href),
      title,
      url: absolutizeUrl(href, source.careersUrl),
      description: title,
    });
  }

  return out;
}

function extractStructuredTitles(
  html: string,
  source: CompanyCareerSourceConfig,
  query: JobSearchQuery,
): Array<{ id?: string; title: string; url?: string; location?: string; description?: string }> {
  const decoded = decodeHtml(html);
  const out: Array<{ id?: string; title: string; url?: string; location?: string; description?: string }> = [];
  const patterns = [
    /"title"\s*:\s*"([^"]{4,140})"/gi,
    /\\"title\\"\s*:\s*\\"([^"]{4,140})\\"/gi,
    /"jobTitle"\s*:\s*"([^"]{4,140})"/gi,
    /"name"\s*:\s*"([^"]{4,140})"/gi,
    /"key"\s*:\s*"position\.profession"\s*,\s*"value"\s*:\s*\[\s*"([^"]{4,140})"/gi,
    /"descriptionTeaser"\s*:\s*"([^"]{20,260})"/gi,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(decoded))) {
      const value = cleanText(match[1]);
      const title = value.length > 90 ? titleFromDescription(value, query) : value;
      if (!title || !looksLikeJob(title, source.careersUrl, query)) continue;
      out.push({
        id: slugify(title),
        title,
        url: source.careersUrl,
        description: value,
      });
    }
  }

  return out;
}

function extractHeadingTitles(
  html: string,
  source: CompanyCareerSourceConfig,
  query: JobSearchQuery,
): Array<{ id?: string; title: string; url?: string; location?: string; description?: string }> {
  const out: Array<{ id?: string; title: string; url?: string; location?: string; description?: string }> = [];
  const headingPattern = /<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/gi;
  let match: RegExpExecArray | null;
  while ((match = headingPattern.exec(html))) {
    const title = cleanText(match[1]);
    if (!title || title.length > 140 || !looksLikeJob(title, source.careersUrl, query)) continue;
    out.push({
      id: slugify(title),
      title,
      url: source.careersUrl,
      description: title,
    });
  }
  return out;
}

function titleFromDescription(value: string, query: JobSearchQuery): string {
  const roleTokens = tokenize(query.role).filter((token) => token.length >= 3);
  const sentence = value
    .split(/[.!?]/)
    .find((part) => roleTokens.some((token) => part.toLowerCase().includes(token)));
  return cleanText(sentence || value).slice(0, 120);
}

function looksLikeJob(title: string, href: string, query: JobSearchQuery): boolean {
  const haystack = `${title} ${href}`.toLowerCase();
  if (!/(job|career|position|opening|role|software|engineer|developer|backend|platform|cloud|data)/.test(haystack)) {
    return false;
  }
  const tokens = [...tokenize(query.role), ...(query.skills || []).flatMap(tokenize)].filter(
    (token) => token.length >= 3,
  );
  return tokens.length === 0 || tokens.some((token) => haystack.includes(token));
}

function dedupeCandidates<T extends { title: string; url?: string }>(values: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const value of values) {
    const key = `${value.title.toLowerCase()}::${value.url || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function inferRequirements(text: string): string[] {
  const lower = cleanText(text).toLowerCase();
  const keywords = [
    'typescript',
    'javascript',
    'node',
    'react',
    'python',
    'java',
    'go',
    'kubernetes',
    'distributed systems',
    'postgres',
    'mongodb',
    'redis',
    'aws',
    'gcp',
    'azure',
    'machine learning',
    'ai',
  ];
  return keywords.filter((keyword) => lower.includes(keyword)).slice(0, 10);
}

function tokenize(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9+#.]+/g).filter(Boolean);
}

function locationName(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'name' in value) {
    return String((value as { name?: string }).name || '');
  }
  return '';
}

function fieldName(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'name' in value) {
    return String((value as { name?: string }).name || '');
  }
  return '';
}

function cleanText(value: string): string {
  return decodeHtml(value)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'");
}

function absolutizeUrl(value: string, base: string): string | undefined {
  try {
    return new URL(value, base).toString();
  } catch {
    return undefined;
  }
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const output: R[] = new Array(values.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), values.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        output[index] = await mapper(values[index], index);
      }
    }),
  );

  return output;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}
