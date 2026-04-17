import OpenAI from "openai";
import { env } from "../config/env";
import { JobPosting, JobSearchQuery } from "../types";

interface GroqExtractedJob {
  title?: string;
  company?: string;
  location?: string;
  description?: string;
  requirements?: string[];
  applyUrl?: string;
  salaryLpa?: number;
}

export class GroqScraperService {
  private client: OpenAI | null;

  constructor() {
    if (!env.GROQ_SCRAPER_ENABLED || !env.GROQ_API_KEY) {
      this.client = null;
      return;
    }

    this.client = new OpenAI({
      apiKey: env.GROQ_API_KEY,
      baseURL: env.GROQ_BASE_URL
    });
  }

  isEnabled(): boolean {
    return Boolean(this.client);
  }

  async extractJobsFromHtml(source: string, html: string, query: JobSearchQuery): Promise<JobPosting[]> {
    if (!this.client) return [];

    const trimmed = html.slice(0, 55_000);
    const prompt = [
      "Extract job listings from HTML and return strict JSON only.",
      "Return shape: {\"jobs\":[{\"title\":string,\"company\":string,\"location\":string,\"description\":string,\"requirements\":string[],\"applyUrl\":string,\"salaryLpa\":number}]}",
      "Rules:",
      "- Only include relevant roles matching requested role/skills.",
      "- Keep only valid URLs for applyUrl when possible.",
      "- Keep output concise and factual.",
      `Role=${query.role}`,
      `Skills=${(query.skills || []).join(", ")}`,
      `PreferredLocations=${(query.filters?.locations || []).join(", ")}`,
      `HTML_SOURCE=${source}`,
      "HTML_START",
      trimmed,
      "HTML_END"
    ].join("\n");

    try {
      const res = await this.client.responses.create({
        model: env.GROQ_MODEL_SCRAPER,
        input: prompt
      });

      const parsed = safeParseJson<{ jobs?: GroqExtractedJob[] }>(res.output_text || "");
      const jobs = parsed?.jobs ?? [];

      return jobs
        .filter((job) => job.title && job.company && job.description)
        .map((job, idx) => ({
          source,
          externalId: `groq-${source}-${idx}-${slugify(job.title!)}`,
          title: job.title!,
          company: job.company!,
          location: job.location || query.location || "Remote",
          description: job.description!,
          requirements: (job.requirements || []).slice(0, 10),
          applyUrl: sanitizeUrl(job.applyUrl),
          salaryLpa: job.salaryLpa,
          rawData: {
            strategy: "groq-extract",
            model: env.GROQ_MODEL_SCRAPER
          }
        }));
    } catch {
      return [];
    }
  }
}

function safeParseJson<T>(raw: string): T | null {
  const text = raw.trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last === -1 || first >= last) return null;

  try {
    return JSON.parse(text.slice(first, last + 1)) as T;
  } catch {
    return null;
  }
}

function slugify(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function sanitizeUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.toString();
  } catch {
    return undefined;
  }
}
