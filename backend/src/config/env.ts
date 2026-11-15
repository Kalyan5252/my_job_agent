import fs from 'node:fs';
import path from 'node:path';
import dotenv, { type DotenvParseOutput } from 'dotenv';
import { z } from 'zod';

loadEnv();

const BoolFromEnv = z.preprocess((value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return value;

  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', ''].includes(normalized)) return false;
  return value;
}, z.boolean());

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),
  TRUST_PROXY: BoolFromEnv.default(false),
  CORS_ORIGINS: z.string().default(''),

  // ---- API authentication ----
  // Static keys for scripts/CI/cron (comma-separated, each >= 24 chars). Send as
  // `Authorization: Bearer <key>` or `x-api-key: <key>`.
  API_KEYS: z.string().default(''),
  // Username/password login (POST /auth/login) that returns a short-lived token.
  ADMIN_USERNAME: z.string().default('admin'),
  // scrypt hash produced by `bun run auth:hash-password`.
  ADMIN_PASSWORD_HASH: z.string().optional(),
  AUTH_TOKEN_SECRET: z.string().optional(),
  AUTH_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(300)
    .default(12 * 60 * 60),
  AUTH_LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(10),
  // Local development escape hatch. Refused when NODE_ENV=production.
  AUTH_DISABLED: BoolFromEnv.default(false),

  // ---- Runtime data (resumes, profiles, login sessions, screenshots) ----
  DATA_DIR: z.string().default('data'),
  // Encrypts saved LinkedIn/Google sessions at rest. Required in production.
  DATA_ENCRYPTION_KEY: z.string().optional(),
  MAX_RESUME_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(10 * 1024 * 1024),
  // Allow opening a visible (headed) browser on the API host: interactive
  // LinkedIn/Google login and `preview`/CAPTCHA hand-off. Off by default in production.
  BROWSER_INTERACTIVE_ENABLED: BoolFromEnv.optional(),
  // Use an installed browser instead of Playwright's bundled Chromium (e.g. "chrome").
  BROWSER_CHANNEL: z.string().optional(),
  API_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(60),
  API_RATE_LIMIT_TIME_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),

  AI_PROVIDER: z.enum(['openai', 'openrouter']).default('openai'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL_JOB_SCORING: z.string().default('gpt-5.4'),
  OPENAI_MODEL_JOB_DECISION: z.string().default('gpt-5.4'),
  OPENAI_MODEL_FORM_UNDERSTANDING: z.string().default('gpt-5.4'),
  OPENAI_MODEL_FIELD_MAPPING: z.string().default('gpt-5.4'),
  OPENAI_MODEL_ANSWER_GENERATION: z.string().default('gpt-5.4'),
  OPENAI_MODEL_EMAIL_PARSING: z.string().default('gpt-5.4'),
  OPENAI_MODEL_STATUS_CLASSIFICATION: z.string().default('gpt-5.4'),
  OPENAI_MODEL_SCRAPER: z.string().default('gpt-5.4-mini'),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL_JOB_SCORING: z.string().default('google/gemma-4-31b-it'),
  OPENROUTER_MODEL_JOB_DECISION: z.string().default('google/gemma-4-31b-it'),
  OPENROUTER_MODEL_FORM_UNDERSTANDING: z.string().default('google/gemma-4-31b-it'),
  OPENROUTER_MODEL_FIELD_MAPPING: z.string().default('google/gemma-4-31b-it'),
  OPENROUTER_MODEL_ANSWER_GENERATION: z.string().default('google/gemma-4-31b-it'),
  OPENROUTER_MODEL_EMAIL_PARSING: z.string().default('google/gemma-4-31b-it'),
  OPENROUTER_MODEL_STATUS_CLASSIFICATION: z.string().default('google/gemma-4-31b-it'),
  OPENROUTER_MODEL_SCRAPER: z.string().default('google/gemma-4-31b-it'),
  OPENROUTER_RATE_LIMIT_MAX_RETRIES: z.coerce.number().int().min(0).default(2),
  OPENROUTER_RATE_LIMIT_RETRY_DELAY_MS: z.coerce.number().int().min(0).default(1500),
  DISCOVERY_SCORE_BATCH_DELAY_MS: z.coerce.number().int().min(0).default(1000),
  DISCOVERY_SCORE_RATE_LIMIT_BATCH_SIZE: z.coerce.number().int().min(1).default(10),
  GROQ_API_KEY: z.string().optional(),
  GROQ_BASE_URL: z.string().default('https://api.groq.com/openai/v1'),
  GROQ_MODEL_SCRAPER: z.string().default('openai/gpt-oss-20b'),
  GROQ_SCRAPER_ENABLED: BoolFromEnv.default(false),
  AI_SCRAPER_ENABLED: z
    .preprocess(
      (value) => (value === undefined ? process.env.GROQ_SCRAPER_ENABLED : value),
      BoolFromEnv,
    )
    .default(false),
  AI_SCRAPER_PROVIDER: z.enum(['openai', 'openrouter']).default('openai'),
  SCRAPER_ALLOW_SYNTHETIC_FALLBACK: BoolFromEnv.default(false),
  SCRAPER_DEFAULT_COUNTRY: z.string().default('India'),
  SCRAPER_REMOTE_BOOST: BoolFromEnv.default(false),
  COMPANY_CAREER_SOURCES_ENABLED: BoolFromEnv.default(true),
  APIFY_ENABLED: BoolFromEnv.default(false),
  APIFY_TOKEN: z.string().optional(),
  APIFY_ACTORS: z.string().default(''),
  APIFY_TIMEOUT_SECS: z.coerce.number().int().min(10).max(300).default(120),
  EXPORT_GOOGLE_SHEETS_ENABLED: BoolFromEnv.default(false),
  GOOGLE_SERVICE_ACCOUNT_KEY: z.string().optional(),
  GOOGLE_SHEETS_DRIVE_FOLDER_ID: z.string().optional(),
  GOOGLE_SHEETS_SHARE_EMAIL: z.string().email().optional(),
  INDIAN_JOB_SOURCES_ENABLED: BoolFromEnv.default(true),
  ADZUNA_APP_ID: z.string().optional(),
  ADZUNA_APP_KEY: z.string().optional(),
  RAPIDAPI_KEY: z.string().optional(),
  RAPIDAPI_HOST: z.string().default('jsearch.p.rapidapi.com'),
  LINKEDIN_SCRAPER_ENABLED: BoolFromEnv.default(true),
  LINKEDIN_AUTH_ENABLED: BoolFromEnv.default(true),
  LINKEDIN_STORAGE_STATE_PATH: z.string().optional(),
  GOOGLE_AUTH_ENABLED: BoolFromEnv.default(true),
  GOOGLE_STORAGE_STATE_PATH: z.string().optional(),
  GOOGLE_AUTH_DOMAIN_ALLOWLIST: z.string().default(''),
  // Optional overrides; by default everything lives under DATA_DIR (see config/paths.ts).
  RESUME_FILE_PATH: z.string().optional(),
  RESUME_TEXT_PATH: z.string().optional(),
  CANDIDATE_PROFILE_PATH: z.string().optional(),
  MANUAL_PROFILE_PATH: z.string().optional(),
  SECONDARY_EMAIL: z.string().email().optional(),
  SECONDARY_RESUME_FILE_PATH: z.string().optional(),
  SECONDARY_RESUME_TEXT_PATH: z.string().optional(),
  SECONDARY_CANDIDATE_PROFILE_PATH: z.string().optional(),

  MONGODB_URI: z.string().default('mongodb://localhost:27017'),
  MONGODB_DB_NAME: z.string().default('job_agent'),

  POSTGRES_URL: z.string().default('postgres://postgres:postgres@localhost:5432/job_agent'),
  POSTGRES_SSL_MODE: z.enum(['disable', 'prefer', 'require']).default('prefer'),
  POSTGRES_SSL_REJECT_UNAUTHORIZED: BoolFromEnv.default(true),

  REDIS_ENABLED: BoolFromEnv.default(false),
  REDIS_HOST: z.string().default('127.0.0.1'),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().optional(),
  DISCOVERY_SCRAPE_WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(4),
  DISCOVERY_AI_WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(4),
  DISCOVERY_WRITE_WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(2),
  DISCOVERY_SOURCE_CONCURRENCY: z.coerce.number().int().min(1).default(5),
  DISCOVERY_SOURCE_RATE_LIMIT_MS: z.coerce.number().int().min(0).default(750),
  APPLY_WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(1),

  DISCOVERY_CRON: z.string().default('0 */6 * * *'),
  TRACKING_CRON: z.string().default('*/20 * * * *'),
  TRACKING_LOOKBACK_DAYS: z.coerce.number().int().min(1).max(60).default(7),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().default('Job Agent <job-agent@example.local>'),
  DIGEST_RECIPIENT_EMAIL: z.string().email().optional(),

  IMAP_HOST: z.string().default('imap.gmail.com'),
  IMAP_PORT: z.coerce.number().default(993),
  IMAP_USER: z.string().optional(),
  IMAP_PASSWORD: z.string().optional(),
  IMAP_TLS: BoolFromEnv.default(true),

  DEFAULT_JOB_ROLE: z.string().default('Backend Engineer'),
  DEFAULT_JOB_SKILLS: z
    .string()
    .default(
      'TypeScript,Node.js,Express.js,MongoDB,PostgreSQL,Redis,AWS,GCP,Docker,GraphQL,RAG,LLM,LangChain,React,Next.js',
    ),
  DEFAULT_JOB_EXPERIENCE: z.string().default('fresher'),
});

const ProductionGuards = EnvSchema.superRefine((value, ctx) => {
  const apiKeys = splitList(value.API_KEYS);
  if (apiKeys.some((key) => key.length < 24)) {
    ctx.addIssue({
      code: 'custom',
      path: ['API_KEYS'],
      message: 'Each API key must be >= 24 characters.',
    });
  }
  if (
    value.ADMIN_PASSWORD_HASH &&
    (!value.AUTH_TOKEN_SECRET || value.AUTH_TOKEN_SECRET.length < 32)
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['AUTH_TOKEN_SECRET'],
      message: 'AUTH_TOKEN_SECRET (>= 32 chars) is required when ADMIN_PASSWORD_HASH is set.',
    });
  }
  if (value.DATA_ENCRYPTION_KEY !== undefined && value.DATA_ENCRYPTION_KEY.length < 32) {
    ctx.addIssue({
      code: 'custom',
      path: ['DATA_ENCRYPTION_KEY'],
      message: 'Must be >= 32 characters.',
    });
  }

  if (value.NODE_ENV !== 'production') return;
  if (value.AUTH_DISABLED) {
    ctx.addIssue({
      code: 'custom',
      path: ['AUTH_DISABLED'],
      message: 'AUTH_DISABLED is not allowed in production.',
    });
  }
  if (apiKeys.length === 0 && !value.ADMIN_PASSWORD_HASH) {
    ctx.addIssue({
      code: 'custom',
      path: ['API_KEYS'],
      message: 'Production requires API_KEYS and/or ADMIN_PASSWORD_HASH + AUTH_TOKEN_SECRET.',
    });
  }
  if (!value.DATA_ENCRYPTION_KEY) {
    ctx.addIssue({
      code: 'custom',
      path: ['DATA_ENCRYPTION_KEY'],
      message: 'Production requires DATA_ENCRYPTION_KEY to encrypt saved login sessions.',
    });
  }
});

const parsedEnv = ProductionGuards.safeParse(process.env);
if (!parsedEnv.success) {
  const details = parsedEnv.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${details}`);
}

export const env = parsedEnv.data;

export const apiKeys = splitList(env.API_KEYS);
export const corsOrigins = splitList(env.CORS_ORIGINS);
export const browserInteractiveEnabled =
  env.BROWSER_INTERACTIVE_ENABLED ?? env.NODE_ENV !== 'production';

export function splitList(value: string | undefined): string[] {
  return (value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function loadEnv(): void {
  const cwd = process.cwd();
  const candidates = [
    path.join(cwd, '.env'),
    path.join(cwd, '.env.local'),
    path.resolve(cwd, '..', '.env'),
    path.resolve(cwd, '..', '.env.local'),
  ];
  const merged: DotenvParseOutput = {};

  for (const envPath of candidates) {
    if (fs.existsSync(envPath)) {
      const parsed = dotenv.parse(fs.readFileSync(envPath));
      Object.assign(merged, parsed);
    }
  }

  for (const [key, value] of Object.entries(merged)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
