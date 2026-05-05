import Fastify from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import fs from 'node:fs';
import path from 'node:path';
import { env } from './config/env';
import { DiscoveryWorkflow } from './workflows/discovery.workflow';
import { TrackingWorkflow } from './workflows/tracking.workflow';
import { ApplyWorkflow } from './workflows/apply.workflow';
import { ResumeService } from './services/resume.service';
import { BrowserTool } from './tools/browser.tool';
import {
  ApplicationRunOptions,
  CompanyTier,
  DiscoveryFinding,
  DiscoveryRunResult,
  JobProfile,
  JobSearchQuery,
  ScoredJob,
} from './types';

interface DiscoveryRequestBody extends Partial<JobProfile> {
  location?: string;
  locations?: string[];
  country?: string;
  remoteOnly?: boolean;
  minSalaryLpa?: number;
  minExperienceYears?: number;
  maxExperienceYears?: number;
  maxResults?: number;
  companyTierOrder?: CompanyTier[];
  highPayFirst?: boolean;
}

interface JobFaq {
  question: string;
  answer: string;
}

interface DetailedDiscoveryJob {
  id: string;
  title: string;
  company: string;
  location: string;
  source: string;
  score: number;
  apply: boolean;
  reasoning?: string;
  applyUrl?: string;
  applicationUrl?: string;
  application: {
    hasUrl: boolean;
    url?: string;
  };
  companyTier?: CompanyTier;
  salaryLpa?: number;
  requirementHighlights: string[];
  faqs: JobFaq[];
}

interface ApplicationRequestBody {
  job: Partial<ScoredJob> & {
    id?: string;
    applicationUrl?: string;
    application?: { url?: string };
  };
  profile?: Partial<JobProfile>;
  options?: ApplicationRunOptions;
}

export function createApp() {
  const app = Fastify({ logger: { level: env.LOG_LEVEL } });
  const discovery = new DiscoveryWorkflow();
  const tracking = new TrackingWorkflow();
  const apply = new ApplyWorkflow();
  const browser = new BrowserTool();
  const resume = new ResumeService();
  const openApiRoot = path.resolve(process.cwd(), 'openapi');
  app.register(cors, {
    origin: '*', 
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });

  app.register(swagger, {
    mode: 'static',
    specification: {
      path: path.join(openApiRoot, 'index.yaml'),
      baseDir: openApiRoot,
    },
  });
  app.register(swaggerUi, {
    routePrefix: '/api-docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
    },
    staticCSP: true,
  });

  app.get('/docs', async (_request, reply) => reply.redirect('/api-docs'));
  app.get('/api-docs/paths/*', async (request, reply) => {
    const rawPath = `paths/${(request.params as { '*': string })['*'] || ''}`;
    return sendOpenApiYaml(reply, openApiRoot, rawPath);
  });
  app.get('/api-docs/components/*', async (request, reply) => {
    const rawPath = `components/${(request.params as { '*': string })['*'] || ''}`;
    return sendOpenApiYaml(reply, openApiRoot, rawPath);
  });

  app.get('/health', async () => ({
    ok: true,
    service: 'job-agent',
    at: new Date().toISOString(),
  }));
  app.get('/auth/linkedin/status', async () => ({
    enabled: env.LINKEDIN_AUTH_ENABLED,
    storageStatePath: env.LINKEDIN_STORAGE_STATE_PATH,
    sessionFound: browser.hasLinkedInAuthState(),
  }));
  app.get('/auth/google/status', async () => ({
    enabled: env.GOOGLE_AUTH_ENABLED,
    storageStatePath: env.GOOGLE_STORAGE_STATE_PATH,
    sessionFound: browser.hasGoogleAuthState(),
    probeStatus: await browser.detectGoogleAuthState('https://accounts.google.com', 'google'),
  }));
  app.get('/profile/candidate', async () => {
    const profile = resume.hydrateProfile({
      role: env.DEFAULT_JOB_ROLE,
      skills: env.DEFAULT_JOB_SKILLS.split(',').map((s) => s.trim()),
      experience: env.DEFAULT_JOB_EXPERIENCE,
    });
    return {
      profile,
      computedExperienceYears: profile.computedExperienceYears,
      resumeFilePath: resume.getResumeFilePath(),
      resumeTextLoaded: Boolean(resume.getResumeText().trim().length),
      secondaryIdentity: {
        email: env.SECONDARY_EMAIL,
        resumeFilePath: env.SECONDARY_RESUME_FILE_PATH,
        resumeAvailable: fs.existsSync(resolvePath(env.SECONDARY_RESUME_FILE_PATH)),
        profileAvailable: fs.existsSync(resolvePath(env.SECONDARY_CANDIDATE_PROFILE_PATH)),
      },
      manualProfileAvailable: fs.existsSync(resolvePath(env.MANUAL_PROFILE_PATH)),
    };
  });

  app.post<{ Body: DiscoveryRequestBody }>('/workflows/discovery/run', async (request) => {
    const profile = toProfile(request.body);
    const searchQuery = toSearchQuery(request.body, profile);
    return discovery.run(profile, searchQuery);
  });

  app.post<{ Body: DiscoveryRequestBody }>(
    '/workflows/discovery/understand',
    async (request, reply) => {
      const injected = await app.inject({
        method: 'POST',
        url: '/workflows/discovery/run',
        payload: request.body,
        headers: { 'content-type': 'application/json' },
      });

      if (injected.statusCode >= 400) {
        return reply.code(injected.statusCode).send({
          statusCode: injected.statusCode,
          error: 'Discovery run failed',
          message: injected.body,
        });
      }

      const runResult = injected.json<DiscoveryRunResult>();
      const detailedJobs = runResult.jobs.map((job) => toDetailedDiscoveryJob(job));
      const topRequirementSummary = summarizeRequirements(runResult.jobs);

      return {
        sourceEndpoint: '/workflows/discovery/run',
        executedAt: new Date().toISOString(),
        totals: {
          fetched: runResult.total,
          applyRecommended: runResult.applyCount,
        },
        diagnostics: runResult.diagnostics,
        findings: summarizeFindings(runResult.diagnostics.findings),
        topRequirementSummary,
        jobs: detailedJobs,
      };
    },
  );

  app.post('/workflows/tracking/run', async () => tracking.run());

  app.post<{ Body: ApplicationRequestBody }>(
    '/workflows/application/run',
    async (request, reply) => {
      const body = request.body || ({} as ApplicationRequestBody);
      const normalizedJob = toApplicationJob(body.job);
      if (!normalizedJob.applyUrl) {
        return reply.code(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'job.applyUrl (or job.applicationUrl/application.url) is required',
        });
      }

      const normalizedProfile = toApplicationProfile(body.profile);
      const result = await apply.run({
        job: normalizedJob,
        profile: normalizedProfile,
        options: body.options,
      });

      return {
        success: result.status === 'applied' || result.status === 'draft_filled',
        mode: body.options?.mode ?? 'dry-run',
        result,
      };
    },
  );

  return app;
}

function resolvePath(input: string): string {
  return path.isAbsolute(input) ? input : path.resolve(process.cwd(), input);
}

function sendOpenApiYaml(
  reply: import('fastify').FastifyReply,
  openApiRoot: string,
  rawPath: string,
): unknown {
  const requestedPath = path.resolve(openApiRoot, rawPath);
  const relative = path.relative(openApiRoot, requestedPath);
  const isInsideRoot = Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
  const allowedFile = requestedPath.endsWith('.yaml');

  if (!isInsideRoot || !allowedFile || !fs.existsSync(requestedPath)) {
    return reply.code(404).send({
      statusCode: 404,
      error: 'Not Found',
      message: 'OpenAPI file not found',
    });
  }

  return reply.type('application/yaml').send(fs.readFileSync(requestedPath, 'utf8'));
}

function toProfile(body: DiscoveryRequestBody): JobProfile {
  return {
    role: body.role || env.DEFAULT_JOB_ROLE,
    skills: body.skills || env.DEFAULT_JOB_SKILLS.split(',').map((s) => s.trim()),
    experience: body.experience || env.DEFAULT_JOB_EXPERIENCE,
  };
}

function toSearchQuery(body: DiscoveryRequestBody, profile: JobProfile): Partial<JobSearchQuery> {
  return {
    role: profile.role,
    skills: profile.skills,
    location: body.location,
    maxResults: body.maxResults,
    filters: {
      remoteOnly: body.remoteOnly,
      country: body.country,
      locations: body.locations,
      minSalaryLpa: body.minSalaryLpa,
      minExperienceYears: body.minExperienceYears,
      maxExperienceYears: body.maxExperienceYears,
    },
    priority: {
      companyTierOrder: body.companyTierOrder,
      highPayFirst: body.highPayFirst,
    },
  };
}

function toApplicationProfile(profile?: Partial<JobProfile>): JobProfile {
  return {
    role: profile?.role || env.DEFAULT_JOB_ROLE,
    skills: profile?.skills || env.DEFAULT_JOB_SKILLS.split(',').map((s) => s.trim()),
    experience: profile?.experience || env.DEFAULT_JOB_EXPERIENCE,
  };
}

function toApplicationJob(input: ApplicationRequestBody['job']): ScoredJob {
  const fallbackUrl = input?.applyUrl || input?.applicationUrl || input?.application?.url;
  return {
    source: input?.source || 'direct-input',
    externalId: input?.externalId || input?.id || `manual-${Date.now()}`,
    title: input?.title || 'Unknown Role',
    company: input?.company || 'Unknown Company',
    location: input?.location,
    description: input?.description || '',
    requirements: input?.requirements || [],
    applyUrl: fallbackUrl,
    rawData: input?.rawData,
    companyTier: input?.companyTier,
    salaryLpa: input?.salaryLpa,
    score: input?.score ?? 0,
    apply: input?.apply ?? true,
    reasoning: input?.reasoning,
  };
}

function toDetailedDiscoveryJob(job: ScoredJob): DetailedDiscoveryJob {
  const requirementHighlights = normalizeRequirements(job);
  const location = job.location || 'Not specified';

  const faqs: JobFaq[] = [
    {
      question: 'What skills are required for this role?',
      answer:
        requirementHighlights.length > 0
          ? requirementHighlights.join(', ')
          : 'No explicit requirements were provided in the job data.',
    },
    {
      question: 'Is this role aligned with my profile?',
      answer: `${job.apply ? 'Yes' : 'Maybe not'} (score: ${job.score}/100${job.reasoning ? `, reason: ${job.reasoning}` : ''}).`,
    },
    {
      question: 'Where is this job located?',
      answer: location,
    },
    {
      question: 'How do I apply?',
      answer: job.applyUrl || 'Apply URL not available.',
    },
  ];

  if (job.salaryLpa) {
    faqs.push({
      question: 'What is the estimated salary?',
      answer: `Approx. ${job.salaryLpa} LPA (estimated).`,
    });
  }

  return {
    id: job.externalId,
    title: job.title,
    company: job.company,
    location,
    source: job.source,
    score: job.score,
    apply: job.apply,
    reasoning: job.reasoning,
    applyUrl: job.applyUrl,
    applicationUrl: job.applyUrl,
    application: {
      hasUrl: Boolean(job.applyUrl),
      url: job.applyUrl,
    },
    companyTier: job.companyTier,
    salaryLpa: job.salaryLpa,
    requirementHighlights,
    faqs,
  };
}

function summarizeRequirements(jobs: ScoredJob[]): Array<{ requirement: string; count: number }> {
  const counts = new Map<string, number>();

  for (const job of jobs) {
    for (const req of normalizeRequirements(job)) {
      const key = req.toLowerCase();
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([requirement, count]) => ({ requirement, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

function summarizeFindings(findings: DiscoveryFinding[]): DiscoveryFinding[] {
  return findings.slice(0, 10);
}

function normalizeRequirements(job: ScoredJob): string[] {
  const explicit = (job.requirements || []).map((r) => r.trim()).filter(Boolean);
  if (explicit.length > 0) return dedupeCaseInsensitive(explicit);

  const text = `${job.title} ${job.description}`.toLowerCase();
  const keywordPool = [
    'node.js',
    'typescript',
    'javascript',
    'mongodb',
    'postgresql',
    'redis',
    'rest',
    'api',
    'microservices',
    'docker',
    'kubernetes',
    'aws',
    'gcp',
    'azure',
    'ai',
    'llm',
    'playwright',
  ];
  const inferred = keywordPool.filter((k) => text.includes(k));
  return dedupeCaseInsensitive(inferred);
}

function dedupeCaseInsensitive(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }

  return output;
}
