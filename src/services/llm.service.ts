import OpenAI from "openai";
import { env } from "../config/env";
import { FormField, JobPosting, JobProfile } from "../types";

type LlmProvider = "openai" | "gemini";
type JobStatus = "applied" | "rejected" | "interview" | "unknown";
type LlmTask =
  | "jobScoring"
  | "jobDecision"
  | "fieldMapping"
  | "statusClassification";

interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
}

export class GeminiRateLimitError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "GeminiRateLimitError";
  }
}

export class LLMService {
  private readonly openAiClient: OpenAI | null;

  constructor() {
    this.openAiClient = env.OPENAI_API_KEY ? new OpenAI({ apiKey: env.OPENAI_API_KEY }) : null;
  }

  private fallbackScore(profile: JobProfile, text: string): number {
    const haystack = text.toLowerCase();
    const hits = profile.skills.filter((skill) => haystack.includes(skill.toLowerCase())).length;
    const score = Math.round((hits / Math.max(profile.skills.length, 1)) * 100);
    return Math.max(35, Math.min(95, score));
  }

  async scoreJob(profile: JobProfile, job: JobPosting): Promise<{ score: number; reasoning: string }> {
    if (!this.hasProviderClient()) {
      const score = this.fallbackScore(profile, `${job.title} ${job.description}`);
      return { score, reasoning: `fallback keyword score (no ${this.providerKeyLabel()})` };
    }

    const prompt = `Profile: ${JSON.stringify(profile)}\nJob: ${JSON.stringify({
      title: job.title,
      company: job.company,
      description: job.description,
      requirements: job.requirements ?? []
    })}\nReturn strict JSON: {"score":number,"reasoning":string}`;

    let text: string;
    try {
      text = await this.createResponseWithFallback("jobScoring", prompt);
    } catch (error) {
      if (isGeminiRateLimitError(error)) {
        throw error;
      }

      const score = this.fallbackScore(profile, `${job.title} ${job.description}`);
      return { score, reasoning: "fallback keyword score (llm request failed)" };
    }

    const parsed = safeParseJson<{ score: number; reasoning: string }>(text);

    if (!parsed) {
      const score = this.fallbackScore(profile, `${job.title} ${job.description}`);
      return { score, reasoning: "fallback parse failure" };
    }

    return {
      score: clamp(parsed.score, 0, 100),
      reasoning: parsed.reasoning || "model result"
    };
  }

  async decideApply(score: number, reasoning: string): Promise<boolean> {
    if (!this.hasProviderClient()) return score >= 70;

    const prompt = `Given score=${score} and reasoning="${reasoning}", decide apply=true/false with strict JSON: {"apply":boolean}`;
    let text: string;
    try {
      text = await this.createResponseWithFallback("jobDecision", prompt);
    } catch (error) {
      if (isGeminiRateLimitError(error)) {
        throw error;
      }

      return score >= 70;
    }

    const parsed = safeParseJson<{ apply: boolean }>(text);
    return parsed?.apply ?? score >= 70;
  }

  async mapFormFields(
    fields: FormField[],
    context: { profile: JobProfile; resumeSummary: string; job: JobPosting }
  ): Promise<Record<string, string>> {
    if (!this.hasProviderClient()) {
      return Object.fromEntries(
        fields.map((field) => [field.name, this.fallbackFieldValue(field, context.profile.role)])
      );
    }

    const prompt = `Map form fields to values.\nFields=${JSON.stringify(fields)}\nContext=${JSON.stringify(
      context
    )}\nReturn strict JSON object where keys are field names and values are answers.`;

    const text = await this.createResponseWithFallback("fieldMapping", prompt);
    const mapped = safeParseJson<Record<string, string>>(text);
    if (!mapped) {
      return Object.fromEntries(
        fields.map((field) => [field.name, this.fallbackFieldValue(field, context.profile.role)])
      );
    }

    return mapped;
  }

  async classifyEmailStatus(emailText: string): Promise<JobStatus> {
    const lower = emailText.toLowerCase();

    if (!this.hasProviderClient()) {
      if (lower.includes("regret") || lower.includes("not moving forward")) return "rejected";
      if (lower.includes("interview") || lower.includes("schedule")) return "interview";
      if (lower.includes("received") || lower.includes("application")) return "applied";
      return "unknown";
    }

    const prompt = `Classify status from email text. Return strict JSON: {"status":"applied|rejected|interview|unknown"}. Text=${emailText}`;
    const text = await this.createResponseWithFallback("statusClassification", prompt);
    const parsed = safeParseJson<{ status: JobStatus }>(text);

    return parsed?.status ?? "unknown";
  }

  private fallbackFieldValue(field: FormField, role: string): string {
    const label = `${field.name} ${field.label}`.toLowerCase();
    if (label.includes("name")) return "Kalyan";
    if (label.includes("email")) return "kalyan@example.com";
    if (label.includes("phone")) return "+91-9000000000";
    if (label.includes("linkedin")) return "https://www.linkedin.com/in/kalyan";
    if (label.includes("github")) return "https://github.com/kalyan";
    if (label.includes("cover") || label.includes("why")) return `I am excited to contribute as a ${role}.`;
    return "N/A";
  }

  private hasProviderClient(): boolean {
    if (env.AI_PROVIDER === "gemini") return Boolean(env.GEMINI_API_KEY);
    return Boolean(this.openAiClient);
  }

  private providerKeyLabel(): string {
    return env.AI_PROVIDER === "gemini" ? "GEMINI_API_KEY" : "OPENAI_API_KEY";
  }

  private async createResponseWithFallback(task: LlmTask, input: string): Promise<string> {
    if (env.AI_PROVIDER === "gemini") {
      return await this.createGeminiResponse(input, this.modelFor(task, "gemini"));
    }

    const { primary, fallback } = this.openAiModelsFor(task);
    return await this.createOpenAiResponse(input, primary, fallback);
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

  private async createGeminiResponse(input: string, model: string): Promise<string> {
    if (!env.GEMINI_API_KEY) {
      throw new Error("Gemini API key is not initialized");
    }

    const retries = env.GEMINI_RATE_LIMIT_MAX_RETRIES;
    let attempt = 0;

    while (true) {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            contents: [
              {
                parts: [{ text: input }]
              }
            ],
            generationConfig: {
              temperature: 0.1,
              responseMimeType: "application/json"
            }
          })
        }
      );

      if (response.ok) {
        const data = (await response.json()) as GeminiGenerateContentResponse;
        return extractGeminiText(data);
      }

      if (response.status !== 429) {
        throw new Error(`Gemini request failed with status ${response.status}`);
      }

      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
      if (attempt >= retries) {
        throw new GeminiRateLimitError(
          `Gemini request failed with status ${response.status}`,
          response.status,
          retryAfterMs
        );
      }

      await sleep(retryAfterMs ?? env.GEMINI_RATE_LIMIT_RETRY_DELAY_MS * (attempt + 1));
      attempt += 1;
    }
  }

  private modelFor(task: LlmTask, provider: LlmProvider): string {
    const models = {
      openai: {
        jobScoring: env.OPENAI_MODEL_JOB_SCORING,
        jobDecision: env.OPENAI_MODEL_JOB_DECISION,
        fieldMapping: env.OPENAI_MODEL_FIELD_MAPPING,
        statusClassification: env.OPENAI_MODEL_STATUS_CLASSIFICATION
      },
      gemini: {
        jobScoring: env.GEMINI_MODEL_JOB_SCORING,
        jobDecision: env.GEMINI_MODEL_JOB_DECISION,
        fieldMapping: env.GEMINI_MODEL_FIELD_MAPPING,
        statusClassification: env.GEMINI_MODEL_STATUS_CLASSIFICATION
      }
    } as const;

    return models[provider][task];
  }

  private openAiModelsFor(task: LlmTask): { primary: string; fallback: string } {
    if (task === "jobDecision") {
      return {
        primary: this.modelFor(task, "openai"),
        fallback: "gpt-5.4"
      };
    }

    return {
      primary: this.modelFor(task, "openai"),
      fallback: "gpt-5.4-mini"
    };
  }
}

function extractGeminiText(data: GeminiGenerateContentResponse): string {
  return (
    data.candidates
      ?.flatMap((candidate) => candidate.content?.parts || [])
      .map((part) => part.text || "")
      .join("") || ""
  );
}

function safeParseJson<T>(raw: string): T | null {
  const trimmed = raw.trim();
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first === -1 || last === -1 || first >= last) return null;

  try {
    return JSON.parse(trimmed.slice(first, last + 1)) as T;
  } catch {
    return null;
  }
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const absolute = Date.parse(value);
  if (Number.isNaN(absolute)) return undefined;

  return Math.max(0, absolute - Date.now());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isGeminiRateLimitError(error: unknown): error is GeminiRateLimitError {
  return error instanceof GeminiRateLimitError;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
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
