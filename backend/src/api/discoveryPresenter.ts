import { DiscoveryFinding, ScoredJob, CompanyTier } from '../types';

interface JobFaq {
  question: string;
  answer: string;
}

export interface DetailedDiscoveryJob {
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

export function toDetailedDiscoveryJob(job: ScoredJob): DetailedDiscoveryJob {
  const requirementHighlights = normalizeRequirements(job);
  const location = job.location || 'Not specified';

  const faqs: JobFaq[] = [
    {
      question: 'What skills are required for this role?',
      answer:
        requirementHighlights.length > 0
          ? requirementHighlights.join(', ')
          : 'No explicit requirements were provided in the job data.',
    },
    {
      question: 'Is this role aligned with my profile?',
      answer: `${job.apply ? 'Yes' : 'Maybe not'} (score: ${job.score}/100${job.reasoning ? `, reason: ${job.reasoning}` : ''}).`,
    },
    {
      question: 'Where is this job located?',
      answer: location,
    },
    {
      question: 'How do I apply?',
      answer: job.applyUrl || 'Apply URL not available.',
    },
  ];

  if (job.salaryLpa) {
    faqs.push({
      question: 'What is the estimated salary?',
      answer: `Approx. ${job.salaryLpa} LPA (estimated).`,
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
      url: job.applyUrl,
    },
    companyTier: job.companyTier,
    salaryLpa: job.salaryLpa,
    requirementHighlights,
    faqs,
  };
}

export function summarizeRequirements(
  jobs: ScoredJob[],
): Array<{ requirement: string; count: number }> {
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

export function summarizeFindings(findings: DiscoveryFinding[]): DiscoveryFinding[] {
  return findings.slice(0, 10);
}

function normalizeRequirements(job: ScoredJob): string[] {
  const explicit = (job.requirements || []).map((r) => r.trim()).filter(Boolean);
  if (explicit.length > 0) return dedupeCaseInsensitive(explicit);

  const text = `${job.title} ${job.description}`.toLowerCase();
  const keywordPool = [
    'node.js',
    'typescript',
    'javascript',
    'mongodb',
    'postgresql',
    'redis',
    'rest',
    'api',
    'microservices',
    'docker',
    'kubernetes',
    'aws',
    'gcp',
    'azure',
    'ai',
    'llm',
    'playwright',
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
