export type ExperienceLevel = "fresher" | "junior" | "mid" | "senior";

export interface JobProfile {
  role: string;
  skills: string[];
  experience: ExperienceLevel | string;
}

export interface JobSearchFilters {
  employmentType?: string[];
  remoteOnly?: boolean;
  postedWithinHours?: number;
  locations?: string[];
  country?: string;
  minSalaryLpa?: number;
  minExperienceYears?: number;
  maxExperienceYears?: number;
}

export type CompanyTier = "top" | "mid" | "other";

export interface JobSearchPriority {
  companyTierOrder?: CompanyTier[];
  highPayFirst?: boolean;
}

export interface JobSearchQuery {
  role: string;
  location?: string;
  skills?: string[];
  filters?: JobSearchFilters;
  priority?: JobSearchPriority;
  maxResults?: number;
}

export interface JobPosting {
  source: string;
  externalId: string;
  title: string;
  company: string;
  companyTier?: CompanyTier;
  salaryLpa?: number;
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
  | "in_progress"
  | "draft_filled"
  | "needs_human"
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

export interface ApplicationRunOptions {
  mode?: "dry-run" | "submit";
}

export interface ApplicationRunResult {
  status: ApplicationStatus;
  message: string;
  errorCode?: string;
  stage: "precheck" | "extract" | "map" | "validate" | "fill" | "submit" | "done";
  filledCount?: number;
  requiredFieldCount?: number;
  missingRequiredFields?: string[];
  missingSelectors?: string[];
  applyUrl?: string;
}
