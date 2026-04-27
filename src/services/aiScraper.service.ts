import OpenAI from "openai";
import { env } from "../config/env";
import { JobPosting, JobSearchQuery } from "../types";

interface ExtractedJob {
  title?: string;
  company?: string;
  location?: string;
  description?: string;
  requirements?: string[];
  applyUrl?: string;
  salaryLpa?: number;
}

export class AiScraperService {
  private readonly openAiClient: OpenAI | null;
  private readonly openRouterClient: OpenAI | null;

  constructor() {
    this.openAiClient = env.OPENAI_API_KEY ? new OpenAI({ apiKey: env.OPENAI_API_KEY }) : null;
    this.openRouterClient = env.OPENROUTER_API_KEY
      ? new OpenAI({
          apiKey: env.OPENROUTER_API_KEY,
          baseURL: "https://openrouter.ai/api/v1"
        })
      : null;
  }

  isEnabled(): boolean {
    if (!env.AI_SCRAPER_ENABLED) return false;
    if (env.AI_SCRAPER_PROVIDER === "openrouter") return Boolean(this.openRouterClient);
    return Boolean(this.openAiClient);
  }

  async extractJobsFromHtml(source: string, html: string, query: JobSearchQuery): Promise<JobPosting[]> {
    if (!this.isEnabled()) return [];

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
      const text =
        env.AI_SCRAPER_PROVIDER === "openrouter"
          ? await this.createOpenRouterResponse(prompt, env.OPENROUTER_MODEL_SCRAPER)
          : await this.createOpenAiResponse(prompt, env.OPENAI_MODEL_SCRAPER, "gpt-5.4-mini");

      const parsed = safeParseJson<{ jobs?: ExtractedJob[] }>(text);
      const jobs = parsed?.jobs ?? [];

      return jobs
        .filter((job) => job.title && job.company && job.description)
        .map((job, idx) => ({
          source,
          externalId: `${env.AI_SCRAPER_PROVIDER}-${source}-${idx}-${slugify(job.title!)}`,
          title: job.title!,
          company: job.company!,
          location: job.location || query.location || "Remote",
          description: job.description!,
          requirements: (job.requirements || []).slice(0, 10),
          applyUrl: sanitizeUrl(job.applyUrl),
          salaryLpa: job.salaryLpa,
          rawData: {
            strategy: `${env.AI_SCRAPER_PROVIDER}-extract`,
            model: this.currentModel()
          }
        }));
    } catch {
      return [];
    }
  }

  private currentModel(): string {
    return env.AI_SCRAPER_PROVIDER === "openrouter"
      ? env.OPENROUTER_MODEL_SCRAPER
      : env.OPENAI_MODEL_SCRAPER;
  }

  private async createOpenAiResponse(input: string, model: string, fallbackModel: string): Promise<string> {
    if (!this.openAiClient) {
      throw new Error("OpenAI client is not initialized");
    }

    const preferredModel = normalizeOpenAiModel(model, fallbackModel);

    try {
      const res = await this.openAiClient.responses.create({
        model: preferredModel,
        input
      });
      return res.output_text || "";
    } catch (error) {
      const modelNotFound = isOpenAiModelNotFound(error);
      if (!modelNotFound || preferredModel === fallbackModel) {
        throw error;
      }

      const res = await this.openAiClient.responses.create({
        model: fallbackModel,
        input
      });
      return res.output_text || "";
    }
  }

  private async createOpenRouterResponse(input: string, model: string): Promise<string> {
    if (!this.openRouterClient) {
      throw new Error("OpenRouter client is not configured");
    }

    const resolvedModel = normalizeOpenRouterModel(model);
    const res = await this.openRouterClient.chat.completions.create({
      model: resolvedModel,
      temperature: 0.1,
      messages: [{ role: "user", content: input }]
    });

    return res.choices[0]?.message?.content ?? "";
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

function normalizeOpenAiModel(model: string, fallbackModel: string): string {
  if (model === "gpt-5.3") return fallbackModel;
  if (model === "gpt-5-mini") return "gpt-5.4-mini";
  return model;
}

function isOpenAiModelNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const maybe = error as { code?: string; error?: { code?: string } };
  return maybe.code === "model_not_found" || maybe.error?.code === "model_not_found";
}

function normalizeOpenRouterModel(model: string): string {
  if (model === "google/gemma-4-31b") return "google/gemma-4-31b-it";
  if (model === "google/gemma-4-26b") return "google/gemma-4-26b-a4b-it";
  return model;
}
