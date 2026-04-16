export type ExperienceLevel = "fresher" | "junior" | "mid" | "senior";

export interface JobProfile {
  role: string;
  skills: string[];
  experience: ExperienceLevel | string;
}

export interface JobPosting {
  source: string;
  externalId: string;
  title: string;
  company: string;
  location?: string;
  description: string;
  requirements?: string[];
  applyUrl?: string;
  rawData?: unknown;
}

export interface ScoredJob extends JobPosting {
  score: number;
  apply: boolean;
  reasoning?: string;
}

export type ApplicationStatus =
  | "queued"
  | "applied"
  | "rejected"
  | "interview"
  | "failed"
  | "unknown";

export interface ApplicationRecord {
  id?: string;
  jobExternalId: string;
  source: string;
  company: string;
  role: string;
  status: ApplicationStatus;
  appliedAt?: Date;
  updatedAt?: Date;
  notes?: string;
}

export interface FormField {
  name: string;
  label: string;
  type: string;
  required: boolean;
  placeholder?: string;
}

export interface FieldAnswer {
  fieldName: string;
  value: string;
}
