import "dotenv/config";
import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.string().default("info"),

  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL_JOB_SCORING: z.string().default("gpt-5-mini"),
  OPENAI_MODEL_JOB_DECISION: z.string().default("gpt-5.3"),
  OPENAI_MODEL_FORM_UNDERSTANDING: z.string().default("gpt-5.3"),
  OPENAI_MODEL_FIELD_MAPPING: z.string().default("gpt-5-mini"),
  OPENAI_MODEL_ANSWER_GENERATION: z.string().default("gpt-5.3"),
  OPENAI_MODEL_EMAIL_PARSING: z.string().default("gpt-5-mini"),
  OPENAI_MODEL_STATUS_CLASSIFICATION: z.string().default("gpt-5-mini"),

  MONGODB_URI: z.string().default("mongodb://localhost:27017"),
  MONGODB_DB_NAME: z.string().default("job_agent"),

  POSTGRES_URL: z.string().default("postgres://postgres:postgres@localhost:5432/job_agent"),

  REDIS_HOST: z.string().default("127.0.0.1"),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().optional(),

  IMAP_HOST: z.string().default("imap.gmail.com"),
  IMAP_PORT: z.coerce.number().default(993),
  IMAP_USER: z.string().optional(),
  IMAP_PASSWORD: z.string().optional(),
  IMAP_TLS: z.coerce.boolean().default(true),

  DEFAULT_JOB_ROLE: z.string().default("Backend Engineer"),
  DEFAULT_JOB_SKILLS: z.string().default("Node.js,MongoDB,AI"),
  DEFAULT_JOB_EXPERIENCE: z.string().default("fresher")
});

export const env = EnvSchema.parse(process.env);
