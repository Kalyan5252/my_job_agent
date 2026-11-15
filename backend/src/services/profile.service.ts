import fs from 'node:fs';
import { z } from 'zod';
import { env } from '../config/env';
import { paths, ResumeIdentity, writeFileAtomic } from '../config/paths';
import { HttpError } from '../lib/httpError';
import { ResumeService } from './resume.service';

const SKILL_DICTIONARY = [
  'TypeScript',
  'JavaScript',
  'Node.js',
  'Express.js',
  'NestJS',
  'MongoDB',
  'PostgreSQL',
  'MySQL',
  'Redis',
  'Kafka',
  'RabbitMQ',
  'AWS',
  'GCP',
  'Azure',
  'Docker',
  'Kubernetes',
  'Terraform',
  'GraphQL',
  'REST',
  'gRPC',
  'LangChain',
  'LLM',
  'RAG',
  'React',
  'Next.js',
  'Vue.js',
  'Angular',
  'Python',
  'Django',
  'FastAPI',
  'Flask',
  'Java',
  'Spring',
  'C++',
  'Go',
  'Rust',
  'Git',
  'Jest',
  'Playwright',
  'Linux/Unix',
  'SQS',
  'Lambda',
  'CI/CD',
  'Tailwind CSS',
];

export const CandidateProfileSchema = z
  .object({
    name: z.string().optional(),
    email: z.string().email().optional().or(z.literal('')),
    phone: z.string().optional(),
    linkedin: z.string().optional(),
    github: z.string().optional(),
    skills: z.array(z.string()).optional(),
    educationHighlights: z.array(z.string()).optional(),
    experienceHighlights: z.array(z.string()).optional(),
    workHistory: z
      .array(
        z.object({
          company: z.string().optional(),
          title: z.string().optional(),
          startDate: z.string().optional(),
          endDate: z.string().optional(),
        }),
      )
      .optional(),
    hasNonCompete: z.boolean().optional(),
    canJoinImmediately: z.boolean().optional(),
    noticePeriodDays: z.number().int().min(0).optional(),
  })
  .passthrough();

export const ManualProfileSchema = z
  .object({
    legalName: z.string().optional(),
    name: z.string().optional(),
    preferredName: z.string().optional(),
    emails: z.array(z.string().email()).optional(),
    phones: z.array(z.string()).optional(),
    skills: z.array(z.string()).optional(),
    address: z
      .object({
        line1: z.string().optional(),
        line2: z.string().optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        postalCode: z.string().optional(),
        country: z.string().optional(),
        full: z.string().optional(),
      })
      .optional(),
    profiles: z
      .object({
        linkedin: z.string().optional(),
        github: z.string().optional(),
        leetcode: z.string().optional(),
      })
      .optional(),
    education: z
      .object({
        university: z.string().optional(),
        degree: z.string().optional(),
        start: z.string().optional(),
        end: z.string().optional(),
      })
      .optional(),
    preferences: z
      .object({
        noticePeriodDays: z.number().int().min(0).optional(),
        canJoinImmediately: z.boolean().optional(),
        hasNonCompete: z.boolean().optional(),
        visaSponsorshipRequiredInIndia: z.boolean().optional(),
        currentSalaryLpa: z.string().optional(),
        expectedSalaryLpa: z.number().min(0).optional(),
        skillYears: z.record(z.number().min(0)).optional(),
      })
      .optional(),
  })
  .strict();

export type CandidateProfileInput = z.infer<typeof CandidateProfileSchema>;
export type ManualProfileInput = z.infer<typeof ManualProfileSchema>;

function readJson<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function grab(pattern: RegExp, source: string): string {
  return source.match(pattern)?.[1]?.trim() ?? '';
}

function normalizeUrl(raw: string, prefix: string): string {
  const value = (raw || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  if (value.includes('.')) return `https://${value}`;
  return `${prefix}${value}`;
}

/** Heuristic resume → structured profile (ported from the old Python importer). */
export function buildCandidateProfileFromText(
  text: string,
  resumeFilePath: string,
): CandidateProfileInput {
  const normalized = text.toLowerCase().replace(/\./g, '');
  const skills = SKILL_DICTIONARY.filter((skill) => {
    const needle = skill.toLowerCase().replace(/\./g, '');
    const escaped = needle.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(normalized);
  });

  const education: string[] = [];
  const experience: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const value = line.trim();
    if (!value) continue;
    const low = value.toLowerCase();
    if (
      ['b.tech', 'btech', 'bachelor', 'master', 'university', 'college', 'cgpa', 'gpa'].some((k) =>
        low.includes(k),
      )
    ) {
      education.push(value);
    }
    if (
      ['intern', 'engineer', 'developer', 'contract', 'full-time', 'freelance'].some((k) =>
        low.includes(k),
      )
    ) {
      experience.push(value);
    }
  }

  return {
    name: grab(/^\s*([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)+)/m, text),
    email: grab(/([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/, text),
    phone: grab(/(\+?\d[\d\s-]{8,}\d)/, text),
    linkedin: normalizeUrl(
      grab(/(?:https?:\/\/)?((?:www\.)?linkedin\.com\/[^\s|)]+)/i, text),
      'https://linkedin.com/in/',
    ),
    github: normalizeUrl(
      grab(/(?:https?:\/\/)?((?:www\.)?github\.com\/[^\s|)]+)/i, text),
      'https://github.com/',
    ),
    skills,
    educationHighlights: education.slice(0, 20),
    experienceHighlights: experience.slice(0, 30),
    resumeFilePath,
    importedAt: new Date().toISOString(),
  };
}

export async function extractPdfText(pdf: Buffer): Promise<string> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const document = await getDocumentProxy(new Uint8Array(pdf));
  const { text } = await extractText(document, { mergePages: false });
  return (Array.isArray(text) ? text : [text]).join('\n');
}

export class ProfileService {
  constructor(private readonly resume = new ResumeService()) {}

  async importResume(
    identity: ResumeIdentity,
    pdf: Buffer,
    options: { keepManualEdits?: boolean } = {},
  ) {
    if (pdf.length === 0) throw new HttpError(400, 'Empty file.');
    if (pdf.length > env.MAX_RESUME_UPLOAD_BYTES) {
      throw new HttpError(413, `Resume exceeds ${env.MAX_RESUME_UPLOAD_BYTES} bytes.`);
    }
    if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new HttpError(415, 'Only PDF resumes are supported.');
    }

    let text: string;
    try {
      text = await extractPdfText(pdf);
    } catch (error) {
      throw new HttpError(
        422,
        `Could not read PDF: ${error instanceof Error ? error.message : error}`,
      );
    }

    const pdfPath = paths.resumePdf(identity);
    writeFileAtomic(pdfPath, pdf);
    writeFileAtomic(paths.resumeText(identity), text);

    const extracted = buildCandidateProfileFromText(text, pdfPath);
    const previous = options.keepManualEdits ? this.getCandidate(identity) : null;
    const profile = previous
      ? { ...extracted, ...stripEmpty(previous), resumeFilePath: pdfPath }
      : extracted;
    writeFileAtomic(paths.candidateProfile(identity), `${JSON.stringify(profile, null, 2)}\n`);

    return {
      identity,
      bytes: pdf.length,
      textLength: text.length,
      warnings:
        text.trim().length < 200
          ? [
              'Very little text extracted; is the PDF scanned? Fill the profile manually via PATCH /profile/candidate.',
            ]
          : [],
      profile,
    };
  }

  getResumeFile(identity: ResumeIdentity): string {
    const filePath = paths.resumePdf(identity);
    if (!fs.existsSync(filePath)) throw new HttpError(404, `No ${identity} resume uploaded.`);
    return filePath;
  }

  deleteResume(identity: ResumeIdentity): boolean {
    let removed = false;
    for (const filePath of [
      paths.resumePdf(identity),
      paths.resumeText(identity),
      paths.candidateProfile(identity),
    ]) {
      if (fs.existsSync(filePath)) {
        fs.rmSync(filePath);
        removed = true;
      }
    }
    return removed;
  }

  getCandidate(identity: ResumeIdentity): CandidateProfileInput | null {
    return readJson<CandidateProfileInput>(paths.candidateProfile(identity));
  }

  patchCandidate(identity: ResumeIdentity, patch: unknown): CandidateProfileInput {
    const parsed = CandidateProfileSchema.parse(patch);
    const current = this.getCandidate(identity) ?? {};
    const next = { ...current, ...parsed, updatedAt: new Date().toISOString() };
    writeFileAtomic(paths.candidateProfile(identity), `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }

  getManual(): ManualProfileInput | null {
    return readJson<ManualProfileInput>(paths.manualProfile());
  }

  putManual(input: unknown): ManualProfileInput {
    const parsed = ManualProfileSchema.parse(input);
    writeFileAtomic(paths.manualProfile(), `${JSON.stringify(parsed, null, 2)}\n`);
    return parsed;
  }

  patchManual(input: unknown): ManualProfileInput {
    const patch = ManualProfileSchema.parse(input);
    const current = this.getManual() ?? {};
    const merged: ManualProfileInput = { ...current, ...patch };
    for (const key of ['address', 'profiles', 'education', 'preferences'] as const) {
      if (patch[key] && current[key]) {
        (merged as Record<string, unknown>)[key] = { ...current[key], ...patch[key] };
      }
    }
    writeFileAtomic(paths.manualProfile(), `${JSON.stringify(merged, null, 2)}\n`);
    return merged;
  }

  overview(defaults: { role: string; skills: string[]; experience: string }) {
    const hydrated = this.resume.hydrateProfile(defaults);
    const identity = (id: ResumeIdentity) => ({
      resumeUploaded: fs.existsSync(paths.resumePdf(id)),
      resumeTextAvailable: fs.existsSync(paths.resumeText(id)),
      candidateProfile: this.getCandidate(id),
    });
    return {
      searchProfile: hydrated,
      computedExperienceYears: hydrated.computedExperienceYears,
      primary: identity('primary'),
      secondary: {
        ...identity('secondary'),
        email: env.SECONDARY_EMAIL ?? this.getCandidate('secondary')?.email,
      },
      manualProfile: this.getManual(),
      readyToApply:
        fs.existsSync(paths.resumePdf('primary')) &&
        Boolean(this.getCandidate('primary')?.email || this.getManual()?.emails?.length),
    };
  }
}

function stripEmpty<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, v]) => v !== '' && v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0),
    ),
  ) as Partial<T>;
}
