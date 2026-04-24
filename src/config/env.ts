import fs from "node:fs";
import path from "node:path";
import dotenv, { type DotenvParseOutput } from "dotenv";
import { z } from "zod";

loadEnv();

const BoolFromEnv = z.preprocess((value) => {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return value;

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off", ""].includes(normalized)) return false;
  return value;
}, z.boolean());

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.string().default("info"),

  AI_PROVIDER: z.enum(["openai", "gemini"]).default("openai"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL_JOB_SCORING: z.string().default("gpt-5.4"),
  OPENAI_MODEL_JOB_DECISION: z.string().default("gpt-5.4"),
  OPENAI_MODEL_FORM_UNDERSTANDING: z.string().default("gpt-5.4"),
  OPENAI_MODEL_FIELD_MAPPING: z.string().default("gpt-5.4"),
  OPENAI_MODEL_ANSWER_GENERATION: z.string().default("gpt-5.4"),
  OPENAI_MODEL_EMAIL_PARSING: z.string().default("gpt-5.4"),
  OPENAI_MODEL_STATUS_CLASSIFICATION: z.string().default("gpt-5.4"),
  OPENAI_MODEL_SCRAPER: z.string().default("gpt-5.4-mini"),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL_JOB_SCORING: z.string().default("gemini-1.5-flash"),
  GEMINI_MODEL_JOB_DECISION: z.string().default("gemini-1.5-flash"),
  GEMINI_MODEL_FORM_UNDERSTANDING: z.string().default("gemini-1.5-flash"),
  GEMINI_MODEL_FIELD_MAPPING: z.string().default("gemini-1.5-flash"),
  GEMINI_MODEL_ANSWER_GENERATION: z.string().default("gemini-1.5-flash"),
  GEMINI_MODEL_EMAIL_PARSING: z.string().default("gemini-1.5-flash"),
  GEMINI_MODEL_STATUS_CLASSIFICATION: z.string().default("gemini-1.5-flash"),
  GEMINI_MODEL_SCRAPER: z.string().default("gemini-1.5-flash"),
  GEMINI_RATE_LIMIT_MAX_RETRIES: z.coerce.number().int().min(0).default(2),
  GEMINI_RATE_LIMIT_RETRY_DELAY_MS: z.coerce.number().int().min(0).default(1500),
  DISCOVERY_SCORE_BATCH_DELAY_MS: z.coerce.number().int().min(0).default(1000),
  DISCOVERY_SCORE_RATE_LIMIT_BATCH_SIZE: z.coerce.number().int().min(1).default(10),
  GROQ_API_KEY: z.string().optional(),
  GROQ_BASE_URL: z.string().default("https://api.groq.com/openai/v1"),
  GROQ_MODEL_SCRAPER: z.string().default("openai/gpt-oss-20b"),
  GROQ_SCRAPER_ENABLED: BoolFromEnv.default(false),
  AI_SCRAPER_ENABLED: z.preprocess(
    (value) => (value === undefined ? process.env.GROQ_SCRAPER_ENABLED : value),
    BoolFromEnv
  ).default(false),
  AI_SCRAPER_PROVIDER: z.enum(["openai", "gemini"]).default("openai"),
  SCRAPER_ALLOW_SYNTHETIC_FALLBACK: BoolFromEnv.default(false),
  INDIAN_JOB_SOURCES_ENABLED: BoolFromEnv.default(true),
  ADZUNA_APP_ID: z.string().optional(),
  ADZUNA_APP_KEY: z.string().optional(),
  RAPIDAPI_KEY: z.string().optional(),
  RAPIDAPI_HOST: z.string().default("jsearch.p.rapidapi.com"),
  LINKEDIN_SCRAPER_ENABLED: BoolFromEnv.default(true),
  LINKEDIN_AUTH_ENABLED: BoolFromEnv.default(true),
  LINKEDIN_STORAGE_STATE_PATH: z.string().default(".auth/linkedin-storage-state.json"),
  GOOGLE_AUTH_ENABLED: BoolFromEnv.default(true),
  GOOGLE_STORAGE_STATE_PATH: z.string().default(".auth/google-storage-state.json"),
  GOOGLE_AUTH_DOMAIN_ALLOWLIST: z.string().default(""),
  RESUME_FILE_PATH: z.string().default("data/resume/Kalyan Show (1).pdf"),
  RESUME_TEXT_PATH: z.string().default("data/profile/resume.txt"),
  CANDIDATE_PROFILE_PATH: z.string().default("data/profile/candidateProfile.json"),
  MANUAL_PROFILE_PATH: z.string().default("data/profile/manualProfile.json"),
  SECONDARY_EMAIL: z.string().default("kalyan.s.apple@gmail.com"),
  SECONDARY_RESUME_FILE_PATH: z.string().default("data/resume/Kalyan Show (2).pdf"),
  SECONDARY_RESUME_TEXT_PATH: z.string().default("data/profile/resume.secondary.txt"),
  SECONDARY_CANDIDATE_PROFILE_PATH: z.string().default("data/profile/candidateProfile.secondary.json"),

  MONGODB_URI: z.string().default("mongodb://localhost:27017"),
  MONGODB_DB_NAME: z.string().default("job_agent"),

  POSTGRES_URL: z.string().default("postgres://postgres:postgres@localhost:5432/job_agent"),
  POSTGRES_SSL_MODE: z.enum(["disable", "prefer", "require"]).default("prefer"),
  POSTGRES_SSL_REJECT_UNAUTHORIZED: BoolFromEnv.default(true),

  REDIS_ENABLED: BoolFromEnv.default(false),
  REDIS_HOST: z.string().default("127.0.0.1"),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().optional(),

  IMAP_HOST: z.string().default("imap.gmail.com"),
  IMAP_PORT: z.coerce.number().default(993),
  IMAP_USER: z.string().optional(),
  IMAP_PASSWORD: z.string().optional(),
  IMAP_TLS: BoolFromEnv.default(true),

  DEFAULT_JOB_ROLE: z.string().default("Backend Engineer"),
  DEFAULT_JOB_SKILLS: z
    .string()
    .default(
      "TypeScript,Node.js,Express.js,MongoDB,PostgreSQL,Redis,AWS,GCP,Docker,GraphQL,RAG,LLM,LangChain,React,Next.js"
    ),
  DEFAULT_JOB_EXPERIENCE: z.string().default("fresher")
});

export const env = EnvSchema.parse(process.env);

function loadEnv(): void {
  const cwd = process.cwd();
  const candidates = [".env", ".env.local"];
  const merged: DotenvParseOutput = {};

  for (const file of candidates) {
    const envPath = path.join(cwd, file);
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
