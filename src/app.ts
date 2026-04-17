import Fastify from "fastify";
import { env } from "./config/env";
import { DiscoveryWorkflow } from "./workflows/discovery.workflow";
import { TrackingWorkflow } from "./workflows/tracking.workflow";
import { ApplyWorkflow } from "./workflows/apply.workflow";
import { CompanyTier, JobProfile, JobSearchQuery, ScoredJob } from "./types";

interface DiscoveryRequestBody extends Partial<JobProfile> {
  location?: string;
  locations?: string[];
  country?: string;
  minSalaryLpa?: number;
  maxResults?: number;
  companyTierOrder?: CompanyTier[];
  highPayFirst?: boolean;
}

interface DiscoveryRunResponse {
  total: number;
  applyCount: number;
  jobs: ScoredJob[];
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

export function createApp() {
  const app = Fastify({ logger: { level: env.LOG_LEVEL } });
  const discovery = new DiscoveryWorkflow();
  const tracking = new TrackingWorkflow();
  const apply = new ApplyWorkflow();

  app.get("/health", async () => ({ ok: true, service: "job-agent", at: new Date().toISOString() }));

  app.post<{ Body: DiscoveryRequestBody }>("/workflows/discovery/run", async (request) => {
    const profile = toProfile(request.body);
    const searchQuery = toSearchQuery(request.body, profile);
    return discovery.run(profile, searchQuery);
  });

  app.post<{ Body: DiscoveryRequestBody }>("/workflows/discovery/understand", async (request, reply) => {
    const injected = await app.inject({
      method: "POST",
      url: "/workflows/discovery/run",
      payload: request.body,
      headers: { "content-type": "application/json" }
    });

    if (injected.statusCode >= 400) {
      return reply.code(injected.statusCode).send({
        statusCode: injected.statusCode,
        error: "Discovery run failed",
        message: injected.body
      });
    }

    const runResult = injected.json<DiscoveryRunResponse>();
    const detailedJobs = runResult.jobs.map((job) => toDetailedDiscoveryJob(job));
    const topRequirementSummary = summarizeRequirements(runResult.jobs);

    return {
      sourceEndpoint: "/workflows/discovery/run",
      executedAt: new Date().toISOString(),
      totals: {
        fetched: runResult.total,
        applyRecommended: runResult.applyCount
      },
      topRequirementSummary,
      jobs: detailedJobs
    };
  });

  app.post("/workflows/tracking/run", async () => tracking.run());

  app.post<{ Body: { job: ScoredJob; profile: JobProfile } }>("/workflows/application/run", async (request) => {
    await apply.run(request.body);
    return { success: true };
  });

  return app;
}

function toProfile(body: DiscoveryRequestBody): JobProfile {
  return {
    role: body.role || env.DEFAULT_JOB_ROLE,
    skills: body.skills || env.DEFAULT_JOB_SKILLS.split(",").map((s) => s.trim()),
    experience: body.experience || env.DEFAULT_JOB_EXPERIENCE
  };
}

function toSearchQuery(body: DiscoveryRequestBody, profile: JobProfile): Partial<JobSearchQuery> {
  return {
    role: profile.role,
    skills: profile.skills,
    location: body.location,
    maxResults: body.maxResults,
    filters: {
      country: body.country,
      locations: body.locations,
      minSalaryLpa: body.minSalaryLpa
    },
    priority: {
      companyTierOrder: body.companyTierOrder,
      highPayFirst: body.highPayFirst
    }
  };
}

function toDetailedDiscoveryJob(job: ScoredJob): DetailedDiscoveryJob {
  const requirementHighlights = normalizeRequirements(job);
  const location = job.location || "Not specified";

  const faqs: JobFaq[] = [
    {
      question: "What skills are required for this role?",
      answer:
        requirementHighlights.length > 0
          ? requirementHighlights.join(", ")
          : "No explicit requirements were provided in the job data."
    },
    {
      question: "Is this role aligned with my profile?",
      answer: `${job.apply ? "Yes" : "Maybe not"} (score: ${job.score}/100${job.reasoning ? `, reason: ${job.reasoning}` : ""}).`
    },
    {
      question: "Where is this job located?",
      answer: location
    },
    {
      question: "How do I apply?",
      answer: job.applyUrl || "Apply URL not available."
    }
  ];

  if (job.salaryLpa) {
    faqs.push({
      question: "What is the estimated salary?",
      answer: `Approx. ${job.salaryLpa} LPA (estimated).`
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
      url: job.applyUrl
    },
    companyTier: job.companyTier,
    salaryLpa: job.salaryLpa,
    requirementHighlights,
    faqs
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

function normalizeRequirements(job: ScoredJob): string[] {
  const explicit = (job.requirements || []).map((r) => r.trim()).filter(Boolean);
  if (explicit.length > 0) return dedupeCaseInsensitive(explicit);

  const text = `${job.title} ${job.description}`.toLowerCase();
  const keywordPool = [
    "node.js",
    "typescript",
    "javascript",
    "mongodb",
    "postgresql",
    "redis",
    "rest",
    "api",
    "microservices",
    "docker",
    "kubernetes",
    "aws",
    "gcp",
    "azure",
    "ai",
    "llm",
    "playwright"
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
