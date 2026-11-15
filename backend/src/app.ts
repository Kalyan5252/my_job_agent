import Fastify, { FastifyReply, FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import fs from 'node:fs';
import path from 'node:path';
import { ZodError, z } from 'zod';
import {
  ApplicationListQuerySchema,
  ApplicationRequestSchema,
  ApplyStoredJobSchema,
  DiscoveryRequestSchema,
  IdentityQuerySchema,
  JobListQuerySchema,
  LoginSchema,
  ReviewNotesSchema,
  ReviewResumeSchema,
  toApplicationJob,
  toProfile,
  toSearchQuery,
} from './api/schemas';
import {
  summarizeFindings,
  summarizeRequirements,
  toDetailedDiscoveryJob,
} from './api/discoveryPresenter';
import { AuthService, Principal } from './auth/auth.service';
import { corsOrigins, env } from './config/env';
import { isInside, paths, SESSION_PROVIDERS, SessionProvider } from './config/paths';
import { connectMongo } from './db/mongo/client';
import { pgPool } from './db/postgres/client';
import { HttpError } from './lib/httpError';
import { DiscoveryPipelineResult } from './pipeline/discovery.types';
import {
  enqueueApplication,
  getApplicationJobStatus,
  getRedisConnection,
  isRedisEnabled,
} from './queues/apply.queue';
import { getDiscoveryRunStatus } from './queues/discovery.queue';
import { ApplicationRepository } from './repositories/application.repository';
import { JobRepository } from './repositories/job.repository';
import { ApplicationService } from './services/application.service';
import { DashboardService } from './services/dashboard.service';
import { EmailDigestService } from './services/emailDigest.service';
import { ManualReviewService } from './services/manualReview.service';
import { ProfileService } from './services/profile.service';
import { SessionService } from './services/session.service';
import { DiscoveryWorkflow } from './workflows/discovery.workflow';
import { TrackingWorkflow } from './workflows/tracking.workflow';
import { ScoredJob } from './types';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
  interface FastifyContextConfig {
    public?: boolean;
  }
}

export interface AppDeps {
  auth?: AuthService;
  discovery?: DiscoveryWorkflow;
  tracking?: TrackingWorkflow;
  applications?: ApplicationService;
  dashboard?: DashboardService;
  manualReviews?: ManualReviewService;
  emailDigest?: EmailDigestService;
  profiles?: ProfileService;
  sessions?: SessionService;
  jobs?: JobRepository;
  applicationRecords?: ApplicationRepository;
  readiness?: () => Promise<Record<string, 'ok' | 'disabled' | string>>;
}

const PUBLIC_PREFIXES = ['/api-docs', '/docs'];

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  return schema.parse(input ?? undefined);
}

function providerParam(value: string): SessionProvider {
  if (!(SESSION_PROVIDERS as readonly string[]).includes(value)) {
    throw new HttpError(
      404,
      `Unknown session provider "${value}". Use one of: ${SESSION_PROVIDERS.join(', ')}`,
    );
  }
  return value as SessionProvider;
}

export function createApp(deps: AppDeps = {}) {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.headers["x-api-key"]', 'req.headers.cookie'],
    },
    trustProxy: env.TRUST_PROXY,
    bodyLimit: 2 * 1024 * 1024,
  });

  const auth = deps.auth ?? new AuthService();
  const discovery = deps.discovery ?? new DiscoveryWorkflow();
  const tracking = deps.tracking ?? new TrackingWorkflow();
  const manualReviews = deps.manualReviews ?? new ManualReviewService();
  const applications = deps.applications ?? new ApplicationService(undefined, manualReviews);
  const dashboard = deps.dashboard ?? new DashboardService(manualReviews);
  const emailDigest = deps.emailDigest ?? new EmailDigestService(dashboard);
  const profiles = deps.profiles ?? new ProfileService();
  const sessions = deps.sessions ?? new SessionService();
  const jobs = deps.jobs ?? new JobRepository();
  const applicationRecords = deps.applicationRecords ?? new ApplicationRepository();
  const readiness = deps.readiness ?? defaultReadiness;
  const openApiRoot = path.resolve(process.cwd(), 'openapi');

  if (!auth.configured && !auth.disabled) {
    app.log.warn(
      'No API credentials configured (API_KEYS / ADMIN_PASSWORD_HASH). All protected routes will return 401.',
    );
  }

  // ---------------------------------------------------------------------------
  // Plugins
  // ---------------------------------------------------------------------------
  app.register(cors, {
    origin: corsOrigins.length > 0 ? corsOrigins : false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Api-Key'],
  });
  app.register(rateLimit, {
    global: true,
    max: env.API_RATE_LIMIT_MAX,
    timeWindow: env.API_RATE_LIMIT_TIME_WINDOW_MS,
    errorResponseBuilder: (_request, context) => ({
      statusCode: context.statusCode,
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Retry after ${context.after}.`,
    }),
  });
  app.register(multipart, {
    limits: { fileSize: env.MAX_RESUME_UPLOAD_BYTES, files: 1, fields: 5 },
  });
  // Raw PDF uploads: `curl --data-binary @resume.pdf -H 'Content-Type: application/pdf'`.
  for (const type of ['application/pdf', 'application/octet-stream']) {
    app.addContentTypeParser(
      type,
      { parseAs: 'buffer', bodyLimit: env.MAX_RESUME_UPLOAD_BYTES },
      (_request, body, done) => done(null, body),
    );
  }
  app.register(swagger, {
    mode: 'static',
    specification: { path: path.join(openApiRoot, 'index.yaml'), baseDir: openApiRoot },
  });
  app.register(swaggerUi, {
    routePrefix: '/api-docs',
    uiConfig: { docExpansion: 'list', deepLinking: true, persistAuthorization: true },
    staticCSP: true,
  });

  // ---------------------------------------------------------------------------
  // Auth + errors
  // ---------------------------------------------------------------------------
  // Callback-style hook: replying without calling done() stops the request reliably.
  app.addHook('onRequest', (request, reply, done) => {
    const url = request.url.split('?')[0];
    if (
      request.method === 'OPTIONS' ||
      request.routeOptions.config?.public ||
      PUBLIC_PREFIXES.some((prefix) => url === prefix || url.startsWith(`${prefix}/`))
    ) {
      done();
      return;
    }

    const principal = auth.authenticate(request.headers);
    if (!principal) {
      reply.code(401).header('WWW-Authenticate', 'Bearer').send({
        statusCode: 401,
        error: 'Unauthorized',
        message:
          'Send `Authorization: Bearer <token|api key>` or `x-api-key: <api key>`. Get a token from POST /auth/login.',
      });
      return;
    }
    request.principal = principal;
    done();
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Validation failed',
        issues: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    const err = error as Error & { statusCode?: number; details?: unknown };
    const statusCode = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (statusCode >= 500) {
      request.log.error({ err: error }, 'request failed');
      return reply.code(statusCode).send({
        statusCode,
        error: 'Internal Server Error',
        message: env.NODE_ENV === 'production' ? 'Unexpected error' : err.message,
      });
    }
    return reply.code(statusCode).send({
      statusCode,
      error:
        statusCode === 404 ? 'Not Found' : statusCode === 401 ? 'Unauthorized' : 'Request Error',
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
  });

  app.setNotFoundHandler((request, reply) =>
    reply
      .code(404)
      .send({
        statusCode: 404,
        error: 'Not Found',
        message: `Route ${request.method} ${request.url.split('?')[0]} not found`,
      }),
  );

  // ---------------------------------------------------------------------------
  // Public routes
  // ---------------------------------------------------------------------------
  app.get('/docs', { config: { public: true } }, async (_request, reply) =>
    reply.redirect('/api-docs'),
  );
  for (const folder of ['paths', 'components']) {
    app.get(`/api-docs/${folder}/*`, { config: { public: true } }, async (request, reply) => {
      const rawPath = `${folder}/${(request.params as { '*': string })['*'] || ''}`;
      return sendOpenApiYaml(reply, openApiRoot, rawPath);
    });
  }

  app.get('/health', { config: { public: true } }, async () => ({
    ok: true,
    service: 'job-agent',
    at: new Date().toISOString(),
  }));

  app.get('/health/ready', { config: { public: true } }, async (_request, reply) => {
    const checks = await readiness();
    const ok = Object.values(checks).every((value) => value === 'ok' || value === 'disabled');
    return reply.code(ok ? 200 : 503).send({ ok, checks, at: new Date().toISOString() });
  });

  app.post(
    '/auth/login',
    {
      config: {
        public: true,
        rateLimit: { max: env.AUTH_LOGIN_RATE_LIMIT_MAX, timeWindow: '15 minutes' },
      },
    },
    async (request, reply) => {
      if (!auth.passwordLoginEnabled) {
        throw new HttpError(
          409,
          'Password login is not configured (ADMIN_PASSWORD_HASH + AUTH_TOKEN_SECRET). Use an API key.',
        );
      }
      const body = parse(LoginSchema, request.body);
      const token = auth.login(body.username, body.password);
      if (!token) {
        request.log.warn({ username: body.username }, 'failed login');
        return reply
          .code(401)
          .send({
            statusCode: 401,
            error: 'Unauthorized',
            message: 'Invalid username or password',
          });
      }
      return token;
    },
  );

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------
  app.get('/auth/me', async (request) => ({ principal: request.principal }));

  // ---------------------------------------------------------------------------
  // Profile & resume
  // ---------------------------------------------------------------------------
  app.get('/profile', async () => profiles.overview(toProfile()));

  app.post('/profile/resume', async (request) => {
    const { identity } = parse(IdentityQuerySchema, request.query);
    const keepManualEdits = (request.query as Record<string, string>)?.keepEdits === 'true';
    const pdf = await readUpload(request);
    return profiles.importResume(identity, pdf, { keepManualEdits });
  });

  app.get('/profile/resume', async (request, reply) => {
    const { identity } = parse(IdentityQuerySchema, request.query);
    const filePath = profiles.getResumeFile(identity);
    return reply
      .type('application/pdf')
      .header('Content-Disposition', `attachment; filename="resume-${identity}.pdf"`)
      .send(fs.createReadStream(filePath));
  });

  app.delete('/profile/resume', async (request) => {
    const { identity } = parse(IdentityQuerySchema, request.query);
    if (!profiles.deleteResume(identity))
      throw new HttpError(404, `No ${identity} resume uploaded.`);
    return { deleted: true, identity };
  });

  app.get('/profile/candidate', async (request) => {
    const { identity } = parse(IdentityQuerySchema, request.query);
    const candidate = profiles.getCandidate(identity);
    if (!candidate)
      throw new HttpError(
        404,
        `No ${identity} candidate profile. Upload a resume first (POST /profile/resume).`,
      );
    return candidate;
  });

  app.patch('/profile/candidate', async (request) => {
    const { identity } = parse(IdentityQuerySchema, request.query);
    return profiles.patchCandidate(identity, request.body);
  });

  app.get('/profile/manual', async () => profiles.getManual() ?? {});
  app.put('/profile/manual', async (request) => profiles.putManual(request.body));
  app.patch('/profile/manual', async (request) => profiles.patchManual(request.body));

  // ---------------------------------------------------------------------------
  // LinkedIn / Google browser sessions
  // ---------------------------------------------------------------------------
  app.get('/sessions', async () => ({
    items: SESSION_PROVIDERS.map((provider) => sessions.status(provider)),
  }));

  app.get<{ Params: { provider: string } }>('/sessions/:provider', async (request) =>
    sessions.status(providerParam(request.params.provider)),
  );

  app.put<{ Params: { provider: string } }>('/sessions/:provider', async (request) =>
    sessions.save(providerParam(request.params.provider), request.body),
  );

  app.delete<{ Params: { provider: string } }>('/sessions/:provider', async (request) => {
    const provider = providerParam(request.params.provider);
    if (!sessions.remove(provider)) throw new HttpError(404, `No saved ${provider} session.`);
    return { deleted: true, provider };
  });

  app.post<{ Params: { provider: string } }>(
    '/sessions/:provider/verify',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request) => sessions.verify(providerParam(request.params.provider)),
  );

  app.post<{ Params: { provider: string } }>('/sessions/:provider/login', async (request) =>
    sessions.startLogin(providerParam(request.params.provider)),
  );

  app.post<{ Params: { provider: string; loginId: string } }>(
    '/sessions/:provider/login/:loginId/complete',
    async (request) =>
      sessions.completeLogin(providerParam(request.params.provider), request.params.loginId),
  );

  app.delete<{ Params: { provider: string; loginId: string } }>(
    '/sessions/:provider/login/:loginId',
    async (request) => {
      providerParam(request.params.provider);
      if (!(await sessions.cancelLogin(request.params.loginId)))
        throw new HttpError(404, 'Login attempt not found.');
      return { cancelled: true };
    },
  );

  // ---------------------------------------------------------------------------
  // Discovery
  // ---------------------------------------------------------------------------
  app.post('/workflows/discovery/run', async (request) => {
    const body = parse(DiscoveryRequestSchema, request.body);
    const profile = toProfile(body);
    return discovery.run(profile, toSearchQuery(body, profile));
  });

  app.post(
    '/workflows/discovery/schedule',
    async (request, reply): Promise<DiscoveryPipelineResult> => {
      const body = parse(DiscoveryRequestSchema, request.body);
      const profile = toProfile(body);
      const queued = await discovery.schedule(profile, toSearchQuery(body, profile));
      reply.code(202);
      return queued;
    },
  );

  app.get<{ Params: { runId: string } }>('/workflows/discovery/runs/:runId', async (request) => {
    const { runId } = request.params;
    const jobsForRun = await jobs.list({ runId, limit: 1 });
    if (!isRedisEnabled()) {
      return {
        runId,
        status: jobsForRun.total > 0 ? 'completed' : 'unknown',
        jobs: jobsForRun.total,
      };
    }
    const status = await getDiscoveryRunStatus(runId);
    return { ...status, jobs: jobsForRun.total };
  });

  app.post('/workflows/discovery/understand', async (request) => {
    const body = parse(DiscoveryRequestSchema, request.body);
    const profile = toProfile(body);
    const runResult = await discovery.run(profile, toSearchQuery(body, profile));
    return {
      runId: runResult.runId,
      executedAt: new Date().toISOString(),
      totals: { fetched: runResult.total, applyRecommended: runResult.applyCount },
      diagnostics: runResult.diagnostics,
      export: runResult.export,
      findings: summarizeFindings(runResult.diagnostics.findings),
      topRequirementSummary: summarizeRequirements(runResult.jobs),
      jobs: runResult.jobs.map((job) => toDetailedDiscoveryJob(job)),
    };
  });

  // ---------------------------------------------------------------------------
  // Stored jobs
  // ---------------------------------------------------------------------------
  app.get('/jobs', async (request) => jobs.list(parse(JobListQuerySchema, request.query)));

  app.get<{ Params: { id: string } }>('/jobs/:id', async (request) => {
    const job = await jobs.findById(request.params.id);
    if (!job) throw new HttpError(404, 'Job not found');
    return job;
  });

  app.post<{ Params: { id: string }; Querystring: { async?: string } }>(
    '/jobs/:id/apply',
    async (request, reply) => {
      const job = await jobs.findById(request.params.id);
      if (!job) throw new HttpError(404, 'Job not found');
      if (!job.applyUrl) throw new HttpError(422, 'Stored job has no apply URL');
      const body = parse(ApplyStoredJobSchema, request.body);
      const { id: _id, ...scored } = job;
      if (request.query.async === 'true') {
        const queued = await enqueueApplication({
          job: scored,
          profile: toProfile(body.profile),
          options: body.options,
        });
        return reply.code(202).send({ status: 'queued', ...queued });
      }
      return applications.run(scored, toProfile(body.profile), body.options);
    },
  );

  // ---------------------------------------------------------------------------
  // Applications
  // ---------------------------------------------------------------------------
  app.post('/workflows/application/run', async (request) => {
    const body = parse(ApplicationRequestSchema, request.body);
    const job = requireApplyUrl(toApplicationJob(body.job));
    return applications.run(job, toProfile(body.profile), body.options);
  });

  app.post('/workflows/application/schedule', async (request, reply) => {
    const body = parse(ApplicationRequestSchema, request.body);
    const job = requireApplyUrl(toApplicationJob(body.job));
    const queued = await enqueueApplication({
      job,
      profile: toProfile(body.profile),
      options: body.options,
    });
    return reply.code(202).send({ status: 'queued', ...queued });
  });

  app.get<{ Params: { jobId: string } }>('/workflows/application/jobs/:jobId', async (request) => {
    if (!isRedisEnabled())
      throw new HttpError(409, 'Queued applications need Redis (REDIS_ENABLED=true).');
    const status = await getApplicationJobStatus(request.params.jobId);
    if (!status) throw new HttpError(404, 'Queued application not found');
    return status;
  });

  app.get('/applications', async (request) =>
    applicationRecords.list(parse(ApplicationListQuerySchema, request.query)),
  );

  // ---------------------------------------------------------------------------
  // Tracking
  // ---------------------------------------------------------------------------
  app.post('/workflows/tracking/run', async () => tracking.run());

  // ---------------------------------------------------------------------------
  // Manual review queue
  // ---------------------------------------------------------------------------
  app.get<{ Querystring: { status?: string; limit?: string } }>(
    '/manual-reviews',
    async (request) => ({
      items: await manualReviews.list({
        status: request.query.status as never,
        limit: request.query.limit ? Number(request.query.limit) : undefined,
      }),
    }),
  );

  app.get<{ Params: { id: string } }>('/manual-reviews/:id', async (request) => {
    const item = await manualReviews.get(request.params.id);
    if (!item) throw new HttpError(404, 'Review item not found');
    return item;
  });

  app.get<{ Params: { id: string } }>('/manual-reviews/:id/screenshot', async (request, reply) => {
    const item = await manualReviews.get(request.params.id);
    if (!item) throw new HttpError(404, 'Review item not found');
    const filePath = item.screenshotPath ? path.resolve(item.screenshotPath) : '';
    if (!filePath || !isInside(paths.previewsDir(), filePath) || !fs.existsSync(filePath)) {
      throw new HttpError(
        404,
        'No screenshot for this review (run with options.preview=true to capture one).',
      );
    }
    return reply.type('image/png').send(fs.createReadStream(filePath));
  });

  app.post<{ Params: { id: string } }>('/manual-reviews/:id/open', async (request) => {
    const item = await manualReviews.markReviewing(request.params.id);
    if (!item) throw new HttpError(404, 'Review item not found');
    return item;
  });

  app.post<{ Params: { id: string } }>('/manual-reviews/:id/resume', async (request, reply) => {
    const body = parse(ReviewResumeSchema, request.body);
    const item = await manualReviews.requestResume(request.params.id, body.notes);
    if (!item) throw new HttpError(404, 'Review item not found');
    if (!body.rerun) return { review: item };

    const options = { ...(item.runOptions ?? {}), ...(body.options ?? {}) };
    const profile = toProfile();
    if (isRedisEnabled()) {
      const queued = await enqueueApplication({
        job: item.job,
        profile,
        options,
        reviewId: item.id,
      });
      return reply.code(202).send({ review: item, rerun: { status: 'queued', ...queued } });
    }
    const outcome = await applications.run(item.job as ScoredJob, profile, options);
    const review =
      outcome.result.status === 'needs_human'
        ? item
        : await manualReviews.resolve(
            item.id,
            `Resumed run finished with status=${outcome.result.status}`,
          );
    return { review, rerun: outcome };
  });

  app.post<{ Params: { id: string } }>('/manual-reviews/:id/resolve', async (request) => {
    const body = parse(ReviewNotesSchema, request.body);
    const item = await manualReviews.resolve(request.params.id, body.notes);
    if (!item) throw new HttpError(404, 'Review item not found');
    return item;
  });

  // ---------------------------------------------------------------------------
  // Dashboard / digest
  // ---------------------------------------------------------------------------
  app.get('/dashboard/summary', async () => ({
    ...(await dashboard.snapshot()),
    applications: await applicationRecords.statusCounts(),
  }));
  app.get('/digests/email/preview', async () => emailDigest.buildDigest());
  app.post('/digests/email/send', async () => emailDigest.sendDigest());

  return app;
}

function requireApplyUrl(job: ScoredJob): ScoredJob {
  if (!job.applyUrl) {
    throw new HttpError(
      400,
      'job.applyUrl (or job.applicationUrl / job.application.url) is required',
    );
  }
  return job;
}

async function readUpload(request: FastifyRequest): Promise<Buffer> {
  if (request.isMultipart()) {
    const file = await request.file();
    if (!file) throw new HttpError(400, 'Multipart upload must include a file field.');
    const buffer = await file.toBuffer();
    if (file.file.truncated)
      throw new HttpError(413, `Resume exceeds ${env.MAX_RESUME_UPLOAD_BYTES} bytes.`);
    return buffer;
  }
  if (Buffer.isBuffer(request.body)) return request.body;
  throw new HttpError(
    415,
    'Upload the PDF as multipart/form-data (field "file") or as a raw body with Content-Type: application/pdf.',
  );
}

async function defaultReadiness(): Promise<Record<string, string>> {
  const check = async (fn: () => Promise<unknown>) => {
    try {
      await Promise.race([
        fn(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3_000)),
      ]);
      return 'ok';
    } catch (error) {
      return `error: ${error instanceof Error ? error.message : String(error)}`;
    }
  };

  return {
    mongo: await check(async () => (await connectMongo()).command({ ping: 1 })),
    postgres: await check(() => pgPool.query('SELECT 1')),
    redis: isRedisEnabled() ? await check(() => getRedisConnection().ping()) : 'disabled',
  };
}

function sendOpenApiYaml(reply: FastifyReply, openApiRoot: string, rawPath: string): unknown {
  const requestedPath = path.resolve(openApiRoot, rawPath);
  if (
    !isInside(openApiRoot, requestedPath) ||
    !requestedPath.endsWith('.yaml') ||
    !fs.existsSync(requestedPath)
  ) {
    return reply
      .code(404)
      .send({ statusCode: 404, error: 'Not Found', message: 'OpenAPI file not found' });
  }
  return reply.type('application/yaml').send(fs.readFileSync(requestedPath, 'utf8'));
}
