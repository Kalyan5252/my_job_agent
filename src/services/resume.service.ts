import fs from "node:fs";
import path from "node:path";
import { env } from "../config/env";
import { FormField, JobProfile } from "../types";

interface CandidateProfile {
  legalName?: string;
  preferredName?: string;
  name?: string;
  email?: string;
  emails?: string[];
  phone?: string;
  phones?: string[];
  linkedin?: string;
  github?: string;
  leetcode?: string;
  addressFull?: string;
  city?: string;
  state?: string;
  country?: string;
  postalCode?: string;
  university?: string;
  degree?: string;
  skills?: string[];
  educationHighlights?: string[];
  experienceHighlights?: string[];
  resumeFilePath?: string;
  noticePeriodDays?: number;
  canJoinImmediately?: boolean;
  hasNonCompete?: boolean;
  visaSponsorshipRequiredInIndia?: boolean;
  currentSalaryLpa?: string;
  expectedSalaryLpa?: number;
  skillYears?: Record<string, number>;
}

export class ResumeService {
  private candidateCache: CandidateProfile | null = null;
  private resumeTextCache: string | null = null;

  summarizeForRole(profile: JobProfile): string {
    const hydrated = this.hydrateProfile(profile);
    const candidate = this.getCandidateProfile();
    const skills = hydrated.skills.join(", ");
    const education = (candidate.educationHighlights || []).slice(0, 2).join(" | ");
    const experience = (candidate.experienceHighlights || []).slice(0, 2).join(" | ");
    return [
      `Candidate targeting ${hydrated.role} with ${hydrated.experience} experience level.`,
      `Core skills: ${skills}.`,
      education ? `Education: ${education}.` : "",
      experience ? `Experience: ${experience}.` : ""
    ]
      .filter(Boolean)
      .join(" ");
  }

  hydrateProfile(input: JobProfile): JobProfile {
    const candidate = this.getCandidateProfile();
    const mergedSkills = new Set<string>([...(input.skills || []), ...((candidate.skills || []).filter(Boolean))]);

    return {
      role: input.role || "Backend Engineer",
      skills: Array.from(mergedSkills),
      experience: input.experience || "junior"
    };
  }

  enrichMappedValues(
    fields: FormField[],
    mappedValues: Record<string, unknown>,
    profile: JobProfile
  ): Record<string, string> {
    const candidate = this.getCandidateProfile();
    const out: Record<string, string> = Object.fromEntries(
      Object.entries(mappedValues || {}).map(([key, value]) => [key, this.asText(value)])
    );

    for (const field of fields) {
      const key = field.name;
      const label = `${field.name} ${field.label} ${field.placeholder || ""}`.toLowerCase();
      const current = this.asText(out[key]).trim();

      if (this.isOptionalSalaryField(label, field.required)) {
        out[key] = "";
        continue;
      }

      const fallback = this.knowledgeValue(label, candidate, profile);
      const forceTruth = this.shouldForceProfileTruth(label);

      if ((forceTruth || !current) && fallback) {
        out[key] = fallback;
      }
    }

    return out;
  }

  getResumeText(): string {
    if (this.resumeTextCache !== null) return this.resumeTextCache;
    const resumePath = this.resolvePath(env.RESUME_TEXT_PATH);
    if (!fs.existsSync(resumePath)) {
      this.resumeTextCache = "";
      return this.resumeTextCache;
    }
    this.resumeTextCache = fs.readFileSync(resumePath, "utf8");
    return this.resumeTextCache;
  }

  getResumeFilePath(): string {
    const candidate = this.getCandidateProfile();
    const pathFromCandidate = candidate.resumeFilePath ? this.resolvePath(candidate.resumeFilePath) : "";
    if (pathFromCandidate && fs.existsSync(pathFromCandidate)) return pathFromCandidate;

    const configured = this.resolvePath(env.RESUME_FILE_PATH);
    return configured;
  }

  private getCandidateProfile(): CandidateProfile {
    if (this.candidateCache) return this.candidateCache;

    const profilePath = this.resolvePath(env.CANDIDATE_PROFILE_PATH);
    if (!fs.existsSync(profilePath)) {
      this.candidateCache = {};
      return this.candidateCache;
    }

    try {
      const raw = fs.readFileSync(profilePath, "utf8");
      const parsed = JSON.parse(raw) as CandidateProfile;
      const manual = this.loadManualProfile();
      this.candidateCache = {
        ...parsed,
        ...manual,
        name: manual.name || parsed.name,
        linkedin: this.normalizeUrl(parsed.linkedin, "https://linkedin.com/in/"),
        github: this.normalizeUrl(parsed.github, "https://github.com/"),
        leetcode: this.normalizeUrl(manual.leetcode, "https://leetcode.com/u/"),
        emails: manual.emails && manual.emails.length > 0 ? manual.emails : parsed.emails,
        phones: manual.phones && manual.phones.length > 0 ? manual.phones : parsed.phones,
        email: manual.emails?.[0] || manual.email || parsed.email,
        phone: manual.phones?.[0] || manual.phone || parsed.phone
      };
      return this.candidateCache;
    } catch {
      this.candidateCache = {};
      return this.candidateCache;
    }
  }

  private knowledgeValue(label: string, candidate: CandidateProfile, profile: JobProfile): string {
    if (includesAny(label, ["legal name"])) return candidate.legalName || candidate.name || "";
    if (includesAny(label, ["preferred name"])) return candidate.preferredName || candidate.name || "";
    if (includesAny(label, ["full name", "your name", "name"])) return candidate.name || candidate.legalName || "";
    if (includesAny(label, ["email", "e-mail"])) return candidate.email || candidate.emails?.[0] || "";
    if (includesAny(label, ["alternate email", "secondary email"])) return candidate.emails?.[1] || candidate.email || "";
    if (includesAny(label, ["phone", "mobile", "contact number"])) return candidate.phone || candidate.phones?.[0] || "";
    if (includesAny(label, ["alternate phone", "secondary phone"])) return candidate.phones?.[1] || candidate.phone || "";
    if (includesAny(label, ["address", "street", "line1", "line 1"])) return candidate.addressFull || "";
    if (includesAny(label, ["city", "town"])) return candidate.city || "";
    if (includesAny(label, ["state", "province", "region"])) return candidate.state || "";
    if (includesAny(label, ["country"])) return candidate.country || "";
    if (includesAny(label, ["zip", "postal", "pincode", "pin code"])) return candidate.postalCode || "";
    if (includesAny(label, ["linkedin"])) return candidate.linkedin || "";
    if (includesAny(label, ["github"])) return candidate.github || "";
    if (includesAny(label, ["leetcode"])) return candidate.leetcode || "";
    if (includesAny(label, ["skills", "tech stack", "technology"])) return (profile.skills || []).join(", ");
    if (includesAny(label, ["current role", "position", "job title"])) return profile.role || "";
    if (includesAny(label, ["experience", "years"])) return String(profile.experience || "junior");
    if (includesAny(label, ["education", "degree", "college", "university"])) {
      return candidate.university || candidate.degree || (candidate.educationHighlights || []).slice(0, 1).join(" ");
    }
    if (
      includesAny(label, [
        "have you completed",
        "completed the following level of education",
        "bachelor's degree",
        "bachelors degree",
        "b.tech",
        "btech"
      ])
    ) {
      return "Yes";
    }
    const skillYears = this.skillYearsFromQuestion(label, candidate, profile);
    if (skillYears !== null) {
      return String(skillYears);
    }
    if (includesAny(label, ["about", "summary", "cover", "why"])) {
      return this.summarizeForRole(profile);
    }
    if (includesAny(label, ["notice period", "joining period"])) {
      if (candidate.canJoinImmediately !== false) return "0";
      return String(candidate.noticePeriodDays ?? 0);
    }
    if (includesAny(label, ["last working day", "lwd"])) return "N/A";
    if (includesAny(label, ["non-compete", "non compete"])) {
      return candidate.hasNonCompete ? "Yes" : "No";
    }
    if (includesAny(label, ["restriction", "restrict", "prevent you from working"])) return "No restrictions";
    if (includesAny(label, ["visa sponsorship", "sponsorship", "work authorization", "authorized to work"])) {
      return candidate.visaSponsorshipRequiredInIndia ? "Yes" : "No";
    }
    if (
      includesAny(label, [
        "current salary",
        "ctc",
        "present salary",
        "current compensation",
        "current ctc",
        "existing salary"
      ])
    ) {
      return candidate.currentSalaryLpa || "N/A";
    }
    if (
      includesAny(label, [
        "salary expectation",
        "salary expectations",
        "expected salary",
        "expected ctc",
        "compensation expectation",
        "base salary expectation",
        "base salary expectations",
        "base salary"
      ])
    ) {
      const expected = candidate.expectedSalaryLpa ?? 20;
      return `${expected} LPA`;
    }
    if (includesAny(label, ["consent", "privacy", "terms", "process data", "contact me"])) {
      return "Yes";
    }
    return "";
  }

  private normalizeUrl(value: string | undefined, prefix: string): string {
    const v = (value || "").trim();
    if (!v) return "";
    if (v.startsWith("http://") || v.startsWith("https://")) return v;
    if (v.includes(".")) return `https://${v}`;
    return `${prefix}${v}`;
  }

  private resolvePath(p: string): string {
    return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
  }

  private loadManualProfile(): CandidateProfile {
    const manualPath = this.resolvePath(env.MANUAL_PROFILE_PATH);
    if (!fs.existsSync(manualPath)) return {};
    try {
      const raw = JSON.parse(fs.readFileSync(manualPath, "utf8")) as {
        legalName?: string;
        name?: string;
        preferredName?: string;
        emails?: string[];
        phones?: string[];
        profiles?: { linkedin?: string; github?: string; leetcode?: string };
        address?: {
          full?: string;
          city?: string;
          state?: string;
          country?: string;
          postalCode?: string;
        };
        education?: { university?: string; degree?: string };
        preferences?: {
          noticePeriodDays?: number;
          canJoinImmediately?: boolean;
          hasNonCompete?: boolean;
          visaSponsorshipRequiredInIndia?: boolean;
          currentSalaryLpa?: string;
          expectedSalaryLpa?: number;
          skillYears?: Record<string, number>;
        };
      };

      return {
        legalName: raw.legalName,
        name: raw.name,
        preferredName: raw.preferredName,
        emails: raw.emails || [],
        phones: raw.phones || [],
        email: raw.emails?.[0],
        phone: raw.phones?.[0],
        linkedin: this.normalizeUrl(raw.profiles?.linkedin, "https://linkedin.com/in/"),
        github: this.normalizeUrl(raw.profiles?.github, "https://github.com/"),
        leetcode: this.normalizeUrl(raw.profiles?.leetcode, "https://leetcode.com/u/"),
        addressFull: raw.address?.full,
        city: raw.address?.city,
        state: raw.address?.state,
        country: raw.address?.country,
        postalCode: raw.address?.postalCode,
        university: raw.education?.university,
        degree: raw.education?.degree,
        noticePeriodDays: raw.preferences?.noticePeriodDays,
        canJoinImmediately: raw.preferences?.canJoinImmediately,
        hasNonCompete: raw.preferences?.hasNonCompete,
        visaSponsorshipRequiredInIndia: raw.preferences?.visaSponsorshipRequiredInIndia,
        currentSalaryLpa: raw.preferences?.currentSalaryLpa,
        expectedSalaryLpa: raw.preferences?.expectedSalaryLpa,
        skillYears: raw.preferences?.skillYears
      };
    } catch {
      return {};
    }
  }

  private isOptionalSalaryField(label: string, required: boolean): boolean {
    if (required) return false;
    return includesAny(label, [
      "salary",
      "ctc",
      "compensation",
      "pay expectation",
      "current salary",
      "expected salary"
    ]);
  }

  private shouldForceProfileTruth(label: string): boolean {
    return includesAny(label, [
      "non-compete",
      "non compete",
      "visa sponsorship",
      "work authorization",
      "authorized to work",
      "notice period",
      "joining period",
      "last working day",
      "current salary",
      "present salary",
      "expected salary",
      "salary expectation",
      "have you completed",
      "bachelor's degree",
      "bachelors degree",
      "how many years of work experience do you have with",
      "consent",
      "privacy",
      "terms",
      "process data",
      "contact me"
    ]);
  }

  private skillYearsFromQuestion(label: string, candidate: CandidateProfile, profile: JobProfile): number | null {
    if (!label.includes("how many years") && !label.includes("years of work experience")) return null;
    if (!label.includes("with")) return null;

    const parsed = label.match(/with\s+([a-z0-9.+#/\-\s]+)\??/i);
    if (!parsed?.[1]) return null;
    const rawSkill = parsed[1].trim().toLowerCase();
    const normalizedSkill = this.normalizeSkillName(rawSkill);
    if (!normalizedSkill) return null;

    const explicitYears = this.getExplicitSkillYears(candidate, normalizedSkill);
    if (explicitYears !== null) return explicitYears;

    const allSkills = new Set<string>(
      [...(candidate.skills || []), ...(profile.skills || [])].map((s) => this.normalizeSkillName(s))
    );
    const hasSkill = Array.from(allSkills).some((s) => this.skillMatches(normalizedSkill, s));
    if (!hasSkill) return 0;

    // Candidate is fresher/junior with internship+contract exposure; default to 1 year for known skills.
    return 1;
  }

  private getExplicitSkillYears(candidate: CandidateProfile, askedSkill: string): number | null {
    const map = candidate.skillYears || {};
    const entries = Object.entries(map);
    if (entries.length === 0) return null;

    for (const [skill, years] of entries) {
      const normalizedKnown = this.normalizeSkillName(skill);
      if (!normalizedKnown) continue;
      if (this.skillMatches(askedSkill, normalizedKnown)) {
        const safe = Number.isFinite(years) ? Math.max(0, years) : 0;
        return Math.round(safe * 10) / 10;
      }
    }

    return null;
  }

  private normalizeSkillName(skill: string): string {
    return (skill || "")
      .toLowerCase()
      .replace(/[\(\)\[\],]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace("react js", "react")
      .replace("react.js", "react")
      .replace("vue js", "vue")
      .replace("vue.js", "vue")
      .replace("node js", "node.js")
      .replace("nodejs", "node.js")
      .replace("express js", "express.js")
      .replace("next js", "next.js");
  }

  private skillMatches(asked: string, known: string): boolean {
    if (!asked || !known) return false;
    if (asked === known) return true;
    if (asked.includes(known) || known.includes(asked)) return true;
    return false;
  }

  private asText(value: unknown): string {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (value === null || value === undefined) return "";
    if (Array.isArray(value)) {
      return value
        .map((item) => this.asText(item).trim())
        .filter(Boolean)
        .join(", ");
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
}

function includesAny(source: string, keys: string[]): boolean {
  return keys.some((k) => source.includes(k));
}
