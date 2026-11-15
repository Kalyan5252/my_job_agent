import { pgPool } from '../db/postgres/client';
import { LLMService } from '../services/llm.service';
import { EmailParserTool, ParsedEmail } from '../tools/emailParser.tool';

type TrackedStatus = 'applied' | 'interview' | 'rejected';

export interface TrackableApplication {
  id: number;
  company: string;
  role: string;
  status: string;
}

export interface TrackingResult {
  scannedEmails: number;
  skippedAlreadyProcessed: number;
  matchedEmails: number;
  updates: number;
  details: Array<{
    subject: string;
    company?: string;
    status?: string;
    updatedRows: number;
    reason: string;
  }>;
}

const COMPANY_SUFFIXES =
  /\b(inc|llc|ltd|limited|pvt|private|corp|corporation|co|company|technologies|technology|tech|labs|software|solutions|systems|services|group|global|india)\b/g;

// Words too generic to identify a company on their own.
const GENERIC_NAMES = new Set([
  'the',
  'app',
  'apps',
  'data',
  'cloud',
  'digital',
  'ai',
  'it',
  'one',
  'team',
  'jobs',
  'careers',
]);

// Higher rank wins; terminal outcomes are never downgraded by a later generic email.
const STATUS_RANK: Record<string, number> = {
  queued: 0,
  in_progress: 1,
  draft_filled: 1,
  needs_human: 1,
  failed: 1,
  unknown: 1,
  applied: 2,
  interview: 3,
  rejected: 4,
};

export function normalizeCompany(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(COMPANY_SUFFIXES, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function senderDomainRoot(from: string): string {
  const domain = from.match(/@([a-z0-9.-]+)/i)?.[1]?.toLowerCase() ?? '';
  const parts = domain.split('.').filter(Boolean);
  // e.g. careers.acme.co.in -> acme ; mail.greenhouse.io -> greenhouse
  const generic = new Set([
    'mail',
    'careers',
    'jobs',
    'email',
    'notifications',
    'noreply',
    'no-reply',
    'hire',
    'talent',
    'co',
    'com',
    'in',
    'io',
    'net',
    'org',
  ]);
  const meaningful = parts.filter((part) => !generic.has(part));
  return meaningful[meaningful.length - 1] ?? '';
}

/**
 * Find the single company this email is about. Returns undefined when no company
 * or more than one company matches, so ambiguous emails never update anything.
 */
export function matchEmailToCompany(
  email: Pick<ParsedEmail, 'subject' | 'from' | 'text'>,
  companies: string[],
): string | undefined {
  const haystack = ` ${normalizeCompany(`${email.subject} ${email.from} ${email.text.slice(0, 4000)}`)} `;
  const domainRoot = senderDomainRoot(email.from);
  const matches = new Set<string>();

  for (const company of companies) {
    const normalized = normalizeCompany(company);
    if (!normalized || normalized.length < 2 || GENERIC_NAMES.has(normalized)) continue;
    const compact = normalized.replace(/\s/g, '');
    if (haystack.includes(` ${normalized} `) || (domainRoot && domainRoot === compact)) {
      matches.add(company);
    }
  }

  return matches.size === 1 ? [...matches][0] : undefined;
}

/** Pick which of a company's applications an email refers to (title match, else most recent). */
export function pickApplication(
  apps: TrackableApplication[],
  email: Pick<ParsedEmail, 'subject' | 'text'>,
): TrackableApplication | undefined {
  if (apps.length <= 1) return apps[0];
  const text = `${email.subject} ${email.text.slice(0, 4000)}`.toLowerCase();
  return apps.find((app) => app.role && text.includes(app.role.toLowerCase())) ?? apps[0];
}

export class TrackerAgent {
  constructor(
    private readonly llm = new LLMService(),
    private readonly emailParser = new EmailParserTool(),
  ) {}

  async run(): Promise<TrackingResult> {
    const result: TrackingResult = {
      scannedEmails: 0,
      skippedAlreadyProcessed: 0,
      matchedEmails: 0,
      updates: 0,
      details: [],
    };
    if (!this.emailParser.isConfigured()) return result;

    const emails = await this.emailParser.fetchRecent();
    result.scannedEmails = emails.length;
    if (emails.length === 0) return result;

    const processed = await pgPool.query<{ message_id: string }>(
      'SELECT message_id FROM processed_emails WHERE message_id = ANY($1)',
      [emails.map((email) => email.messageId)],
    );
    const alreadyProcessed = new Set(processed.rows.map((row) => row.message_id));

    const { rows: apps } = await pgPool.query<TrackableApplication>(
      `SELECT id, company, role, status FROM applications
       WHERE status <> 'rejected'
       ORDER BY updated_at DESC`,
    );
    const companies = [...new Set(apps.map((app) => app.company))];

    for (const email of emails.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime())) {
      if (alreadyProcessed.has(email.messageId)) {
        result.skippedAlreadyProcessed += 1;
        continue;
      }

      const company = matchEmailToCompany(email, companies);
      let status: string | undefined;
      let updatedRows = 0;
      let reason = 'no single matching company';

      if (company) {
        result.matchedEmails += 1;
        status = await this.llm.classifyEmailStatus(
          `${email.subject}\n${email.text.slice(0, 6000)}`,
        );
        const target = pickApplication(
          apps.filter((app) => app.company === company),
          email,
        );

        if (status === 'unknown') {
          reason = 'status not recognised';
        } else if (target && (STATUS_RANK[status] ?? 0) > (STATUS_RANK[target.status] ?? 0)) {
          const update = await pgPool.query(
            `UPDATE applications
             SET status = $2,
                 updated_at = NOW(),
                 notes = RIGHT(COALESCE(notes, '') || $3, 4000)
             WHERE id = $1`,
            [
              target.id,
              status as TrackedStatus,
              `\n[${email.receivedAt.toISOString()}] email: ${email.subject.slice(0, 200)}`,
            ],
          );
          updatedRows = update.rowCount ?? 0;
          target.status = status;
          reason = 'status advanced';
        } else {
          reason = 'status not newer than current';
        }
      }

      result.updates += updatedRows;
      result.details.push({
        subject: email.subject.slice(0, 200),
        company,
        status,
        updatedRows,
        reason,
      });
      await pgPool.query(
        `INSERT INTO processed_emails (message_id, matched_company, classified_status, updated_rows)
         VALUES ($1, $2, $3, $4) ON CONFLICT (message_id) DO NOTHING`,
        [email.messageId, company ?? null, status ?? null, updatedRows],
      );
    }

    return result;
  }
}
