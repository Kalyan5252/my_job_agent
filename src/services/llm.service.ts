import OpenAI from "openai";
import { env } from "../config/env";
import { FormField, JobPosting, JobProfile } from "../types";

export class LLMService {
  private client: OpenAI | null;

  constructor() {
    this.client = env.OPENAI_API_KEY ? new OpenAI({ apiKey: env.OPENAI_API_KEY }) : null;
  }

  private fallbackScore(profile: JobProfile, text: string): number {
    const haystack = text.toLowerCase();
    const hits = profile.skills.filter((skill) => haystack.includes(skill.toLowerCase())).length;
    const score = Math.round((hits / Math.max(profile.skills.length, 1)) * 100);
    return Math.max(35, Math.min(95, score));
  }

  async scoreJob(profile: JobProfile, job: JobPosting): Promise<{ score: number; reasoning: string }> {
    if (!this.client) {
      const score = this.fallbackScore(profile, `${job.title} ${job.description}`);
      return { score, reasoning: "fallback keyword score (no OPENAI_API_KEY)" };
    }

    const prompt = `Profile: ${JSON.stringify(profile)}\nJob: ${JSON.stringify({
      title: job.title,
      company: job.company,
      description: job.description,
      requirements: job.requirements ?? []
    })}\nReturn strict JSON: {"score":number,"reasoning":string}`;

    const res = await this.createResponseWithFallback(
      env.OPENAI_MODEL_JOB_SCORING,
      prompt,
      "gpt-5.4-mini"
    );

    const text = res.output_text || "";
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
    if (!this.client) return score >= 70;

    const prompt = `Given score=${score} and reasoning="${reasoning}", decide apply=true/false with strict JSON: {"apply":boolean}`;
    const res = await this.createResponseWithFallback(
      env.OPENAI_MODEL_JOB_DECISION,
      prompt,
      "gpt-5.4"
    );

    const parsed = safeParseJson<{ apply: boolean }>(res.output_text || "");
    return parsed?.apply ?? score >= 70;
  }

  async mapFormFields(
    fields: FormField[],
    context: { profile: JobProfile; resumeSummary: string; job: JobPosting }
  ): Promise<Record<string, string>> {
    if (!this.client) {
      return Object.fromEntries(
        fields.map((field) => [field.name, this.fallbackFieldValue(field, context.profile.role)])
      );
    }

    const prompt = `Map form fields to values.\nFields=${JSON.stringify(fields)}\nContext=${JSON.stringify(
      context
    )}\nReturn strict JSON object where keys are field names and values are answers.`;

    const res = await this.createResponseWithFallback(
      env.OPENAI_MODEL_FIELD_MAPPING,
      prompt,
      "gpt-5.4-mini"
    );

    const mapped = safeParseJson<Record<string, string>>(res.output_text || "");
    if (!mapped) {
      return Object.fromEntries(
        fields.map((field) => [field.name, this.fallbackFieldValue(field, context.profile.role)])
      );
    }

    return mapped;
  }

  async classifyEmailStatus(emailText: string): Promise<"applied" | "rejected" | "interview" | "unknown"> {
    const lower = emailText.toLowerCase();

    if (!this.client) {
      if (lower.includes("regret") || lower.includes("not moving forward")) return "rejected";
      if (lower.includes("interview") || lower.includes("schedule")) return "interview";
      if (lower.includes("received") || lower.includes("application")) return "applied";
      return "unknown";
    }

    const prompt = `Classify status from email text. Return strict JSON: {"status":"applied|rejected|interview|unknown"}. Text=${emailText}`;
    const res = await this.createResponseWithFallback(
      env.OPENAI_MODEL_STATUS_CLASSIFICATION,
      prompt,
      "gpt-5.4-mini"
    );
    const parsed = safeParseJson<{ status: "applied" | "rejected" | "interview" | "unknown" }>(
      res.output_text || ""
    );

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

  private async createResponseWithFallback(
    model: string,
    input: string,
    fallbackModel: string
  ): Promise<OpenAI.Responses.Response> {
    if (!this.client) {
      throw new Error("OpenAI client is not initialized");
    }

    const preferredModel = this.normalizeLegacyModel(model, fallbackModel);

    try {
      return await this.client.responses.create({
        model: preferredModel,
        input
      });
    } catch (error) {
      const modelNotFound = this.isModelNotFound(error);
      if (!modelNotFound || preferredModel === fallbackModel) {
        throw error;
      }

      return await this.client.responses.create({
        model: fallbackModel,
        input
      });
    }
  }

  private normalizeLegacyModel(model: string, fallbackModel: string): string {
    if (model === "gpt-5.3") return fallbackModel;
    if (model === "gpt-5-mini") return "gpt-5.4-mini";
    return model;
  }

  private isModelNotFound(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const maybe = error as { code?: string; error?: { code?: string } };
    return maybe.code === "model_not_found" || maybe.error?.code === "model_not_found";
  }
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
