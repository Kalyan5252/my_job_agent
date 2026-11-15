import { z } from 'zod';
import { env, splitList } from '../config/env';
import { JobProfile, JobSearchQuery, ScoredJob } from '../types';

const CompanyTier = z.enum(['top', 'mid', 'other']);
const Experience = z.string().min(1).max(40);

export const DiscoveryRequestSchema = z
  .object({
    role: z.string().min(1).max(120).optional(),
    skills: z.array(z.string().min(1).max(60)).max(60).optional(),
    experience: Experience.optional(),
    location: z.string().max(120).optional(),
    locations: z.array(z.string().max(120)).max(20).optional(),
    country: z.string().max(60).optional(),
    remoteOnly: z.boolean().optional(),
    minSalaryLpa: z.number().min(0).max(1000).optional(),
    minExperienceYears: z.number().min(0).max(50).optional(),
    maxExperienceYears: z.number().min(0).max(50).optional(),
    maxResults: z.number().int().min(1).max(200).optional(),
    companyTierOrder: z.array(CompanyTier).max(3).optional(),
    highPayFirst: z.boolean().optional(),
  })
  .strict()
  .default({});

export type DiscoveryRequest = z.infer<typeof DiscoveryRequestSchema>;

export const ProfileInputSchema = z
  .object({
    role: z.string().min(1).max(120).optional(),
    skills: z.array(z.string().min(1).max(60)).max(60).optional(),
    experience: Experience.optional(),
  })
  .strict();

export const ApplicationOptionsSchema = z
  .object({
    mode: z.enum(['dry-run', 'submit']).default('dry-run'),
    preview: z.boolean().optional(),
    authMode: z.enum(['auto', 'google', 'linkedin']).optional(),
    captchaHandoff: z.boolean().optional(),
    captchaHandoffTimeoutMs: z.number().int().min(5_000).max(900_000).optional(),
    keepBrowserOpenAfterSubmit: z.boolean().optional(),
    keepBrowserOpenMs: z.number().int().min(5_000).max(900_000).optional(),
  })
  .strict();

const HttpUrl = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), 'Must be an http(s) URL');

export const ApplicationJobSchema = z
  .object({
    id: z.string().max(300).optional(),
    externalId: z.string().max(300).optional(),
    source: z.string().max(100).optional(),
    title: z.string().max(300).optional(),
    company: z.string().max(200).optional(),
    location: z.string().max(200).optional(),
    description: z.string().max(50_000).optional(),
    requirements: z.array(z.string().max(300)).max(100).optional(),
    applyUrl: HttpUrl.optional(),
    applicationUrl: HttpUrl.optional(),
    application: z.object({ url: HttpUrl.optional() }).optional(),
    companyTier: CompanyTier.optional(),
    salaryLpa: z.number().optional(),
    score: z.number().min(0).max(100).optional(),
    apply: z.boolean().optional(),
    reasoning: z.string().max(2000).optional(),
  })
  .passthrough();

export const ApplicationRequestSchema = z
  .object({
    job: ApplicationJobSchema,
    profile: ProfileInputSchema.optional(),
    options: ApplicationOptionsSchema.optional(),
  })
  .strict();

export const ApplyStoredJobSchema = z
  .object({
    profile: ProfileInputSchema.optional(),
    options: ApplicationOptionsSchema.optional(),
  })
  .strict()
  .default({});

export const LoginSchema = z
  .object({ username: z.string().min(1).max(200), password: z.string().min(1).max(500) })
  .strict();

export const ReviewNotesSchema = z
  .object({ notes: z.string().max(4000).optional() })
  .strict()
  .default({});

export const ReviewResumeSchema = z
  .object({
    notes: z.string().max(4000).optional(),
    rerun: z.boolean().default(true),
    options: ApplicationOptionsSchema.optional(),
  })
  .strict()
  .default({});

export const JobListQuerySchema = z.object({
  runId: z.string().max(200).optional(),
  apply: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  minScore: z.coerce.number().min(0).max(100).optional(),
  source: z.string().max(100).optional(),
  company: z.string().max(200).optional(),
  q: z.string().max(200).optional(),
  sort: z.enum(['score', 'recent']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const ApplicationListQuerySchema = z.object({
  status: z.string().max(40).optional(),
  company: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export const IdentityQuerySchema = z.object({
  identity: z.enum(['primary', 'secondary']).default('primary'),
});

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

export function defaultSkills(): string[] {
  return splitList(env.DEFAULT_JOB_SKILLS);
}

export function toProfile(input?: {
  role?: string;
  skills?: string[];
  experience?: string;
}): JobProfile {
  return {
    role: input?.role || env.DEFAULT_JOB_ROLE,
    skills: input?.skills?.length ? input.skills : defaultSkills(),
    experience: input?.experience || env.DEFAULT_JOB_EXPERIENCE,
  };
}

export function toSearchQuery(
  body: DiscoveryRequest,
  profile: JobProfile,
): Partial<JobSearchQuery> {
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

export function toApplicationJob(input: z.infer<typeof ApplicationJobSchema>): ScoredJob {
  return {
    source: input.source || 'direct-input',
    externalId: input.externalId || input.id || `manual-${Date.now()}`,
    title: input.title || 'Unknown Role',
    company: input.company || 'Unknown Company',
    location: input.location,
    description: input.description || '',
    requirements: input.requirements || [],
    applyUrl: input.applyUrl || input.applicationUrl || input.application?.url,
    companyTier: input.companyTier,
    salaryLpa: input.salaryLpa,
    score: input.score ?? 0,
    apply: input.apply ?? true,
    reasoning: input.reasoning,
  };
}
