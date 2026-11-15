import fs from 'node:fs';
import { google, sheets_v4 } from 'googleapis';
import type { JWT } from 'google-auth-library';
import { env } from '../config/env';
import {
  DiscoveryDiagnostics,
  DiscoveryExportMetadata,
  JobProfile,
  JobSearchQuery,
  ScoredJob,
} from '../types';

export interface DiscoveryExportInput {
  profile: JobProfile;
  searchQuery?: Partial<JobSearchQuery>;
  jobs: ScoredJob[];
  diagnostics: DiscoveryDiagnostics;
}

const GOOGLE_AUTH_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
];

const SUMMARY_SHEET_ID = 0;
const JOBS_SHEET_ID = 1;

const JOBS_HEADERS = [
  'Rank',
  'Title',
  'Company',
  'Location',
  'Source',
  'Company Tier',
  'Salary LPA',
  'Score',
  'Apply',
  'Apply URL',
  'Requirements',
  'Reasoning',
  'External ID',
  'Description',
];

export class DiscoveryExportService {
  private authClient: JWT | null = null;

  async exportDiscoveryRun(input: DiscoveryExportInput): Promise<DiscoveryExportMetadata> {
    const rowCount = input.jobs.length;

    if (!env.EXPORT_GOOGLE_SHEETS_ENABLED) {
      return { status: 'skipped', target: 'google-sheets', rowCount };
    }

    try {
      const auth = this.getAuthClient();
      const sheets = google.sheets({ version: 'v4', auth });
      const drive = google.drive({ version: 'v3', auth });

      const title = `Discovery — ${input.profile.role || 'jobs'} — ${new Date().toISOString()}`;

      const created = await sheets.spreadsheets.create({
        requestBody: {
          properties: { title },
          sheets: [
            { properties: { sheetId: SUMMARY_SHEET_ID, title: 'Summary' } },
            { properties: { sheetId: JOBS_SHEET_ID, title: 'Jobs' } },
          ],
        },
      });

      const spreadsheetId = created.data.spreadsheetId;
      if (!spreadsheetId) {
        throw new Error('Google Sheets API did not return a spreadsheetId');
      }
      const spreadsheetUrl =
        created.data.spreadsheetUrl ||
        `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;

      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [...this.buildSummaryRequests(input), ...this.buildJobsRequests(input.jobs)],
        },
      });

      if (env.GOOGLE_SHEETS_DRIVE_FOLDER_ID) {
        await drive.files.update({
          fileId: spreadsheetId,
          addParents: env.GOOGLE_SHEETS_DRIVE_FOLDER_ID,
          fields: 'id, parents',
          supportsAllDrives: true,
        });
      }

      if (env.GOOGLE_SHEETS_SHARE_EMAIL) {
        await drive.permissions.create({
          fileId: spreadsheetId,
          sendNotificationEmail: false,
          supportsAllDrives: true,
          requestBody: {
            type: 'user',
            role: 'writer',
            emailAddress: env.GOOGLE_SHEETS_SHARE_EMAIL,
          },
        });
      }

      return {
        status: 'created',
        target: 'google-sheets',
        spreadsheetId,
        spreadsheetUrl,
        rowCount,
      };
    } catch (error) {
      console.error(`[export] google sheets export failed: ${formatError(error)}`);
      return {
        status: 'failed',
        target: 'google-sheets',
        rowCount,
        errorMessage: formatError(error),
      };
    }
  }

  private getAuthClient(): JWT {
    if (this.authClient) return this.authClient;

    const credentials = loadServiceAccountCredentials();
    this.authClient = new google.auth.JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: GOOGLE_AUTH_SCOPES,
    });
    return this.authClient;
  }

  private buildSummaryRequests(input: DiscoveryExportInput): sheets_v4.Schema$Request[] {
    const location =
      input.searchQuery?.location || input.searchQuery?.filters?.locations?.join(', ') || 'Any';
    const { counts } = input.diagnostics;

    const rows: SummaryRow[] = [
      sectionRow('Discovery Export'),
      blankRow(),
      sectionRow('Run Details'),
      kvRow('Role', input.profile.role),
      kvRow('Preferred Location', location),
      kvRow('Skills', input.profile.skills.join(', ') || 'N/A'),
      kvRow('Experience', String(input.profile.experience ?? '')),
      kvRow('Total Jobs', String(input.jobs.length)),
      kvRow('Apply Recommended', String(input.jobs.filter((job) => job.apply).length)),
      blankRow(),
      sectionRow('Diagnostics'),
      kvRow('API Jobs', String(counts.apiJobs)),
      kvRow('Indian Jobs', String(counts.indianJobs)),
      kvRow('HTML Jobs', String(counts.htmlJobs)),
      kvRow('Browser Jobs', String(counts.browserJobs)),
      kvRow('Merged Jobs', String(counts.mergedJobs)),
      kvRow('Actionable Jobs', String(counts.actionableJobs)),
      kvRow('Skill Aligned Jobs', String(counts.skillAlignedJobs)),
      kvRow('Candidate Jobs', String(counts.candidateJobs)),
      blankRow(),
      sectionRow('Source Breakdown'),
      headerRow(['Source', 'Jobs']),
    ];

    const sourceEntries = Object.entries(countSources(input.jobs)).sort((a, b) => b[1] - a[1]);
    for (const [source, count] of sourceEntries) {
      rows.push(plainRow([source, String(count)]));
    }

    return [
      {
        updateCells: {
          start: { sheetId: SUMMARY_SHEET_ID, rowIndex: 0, columnIndex: 0 },
          rows: rows.map(toRowData),
          fields: 'userEnteredValue,userEnteredFormat',
        },
      },
      autoResizeRequest(SUMMARY_SHEET_ID, 0, 2),
    ];
  }

  private buildJobsRequests(jobs: ScoredJob[]): sheets_v4.Schema$Request[] {
    const rows: SummaryRow[] = [headerRow(JOBS_HEADERS)];

    jobs.forEach((job, index) => {
      rows.push(
        plainRow([
          String(index + 1),
          job.title,
          job.company,
          job.location || '',
          job.source,
          job.companyTier || '',
          job.salaryLpa != null ? String(job.salaryLpa) : '',
          String(job.score),
          job.apply ? 'Yes' : 'No',
          job.applyUrl || '',
          (job.requirements || []).join(', '),
          job.reasoning || '',
          job.externalId,
          job.description,
        ]),
      );
    });

    return [
      {
        updateCells: {
          start: { sheetId: JOBS_SHEET_ID, rowIndex: 0, columnIndex: 0 },
          rows: rows.map(toRowData),
          fields: 'userEnteredValue,userEnteredFormat',
        },
      },
      {
        updateSheetProperties: {
          properties: {
            sheetId: JOBS_SHEET_ID,
            gridProperties: { frozenRowCount: 1 },
          },
          fields: 'gridProperties.frozenRowCount',
        },
      },
      {
        setBasicFilter: {
          filter: {
            range: {
              sheetId: JOBS_SHEET_ID,
              startRowIndex: 0,
              startColumnIndex: 0,
              endColumnIndex: JOBS_HEADERS.length,
            },
          },
        },
      },
      autoResizeRequest(JOBS_SHEET_ID, 0, JOBS_HEADERS.length),
    ];
  }
}

interface SummaryCell {
  value: string;
  bold?: boolean;
  background?: { red: number; green: number; blue: number };
  foregroundWhite?: boolean;
}

type SummaryRow = SummaryCell[];

const DARK = { red: 0.067, green: 0.094, blue: 0.153 };
const LIGHT = { red: 0.898, green: 0.906, blue: 0.922 };

function sectionRow(title: string): SummaryRow {
  return [{ value: title, bold: true, background: LIGHT }];
}

function headerRow(values: string[]): SummaryRow {
  return values.map((value) => ({
    value,
    bold: true,
    background: DARK,
    foregroundWhite: true,
  }));
}

function kvRow(label: string, value: string): SummaryRow {
  return [{ value: label, bold: true }, { value }];
}

function plainRow(values: string[]): SummaryRow {
  return values.map((value) => ({ value }));
}

function blankRow(): SummaryRow {
  return [{ value: '' }];
}

function toRowData(row: SummaryRow): sheets_v4.Schema$RowData {
  return {
    values: row.map((cell) => {
      const format: sheets_v4.Schema$CellFormat = {};
      if (cell.bold || cell.foregroundWhite) {
        format.textFormat = {
          bold: cell.bold || false,
          foregroundColor: cell.foregroundWhite ? { red: 1, green: 1, blue: 1 } : undefined,
        };
      }
      if (cell.background) {
        format.backgroundColor = cell.background;
      }
      return {
        userEnteredValue: { stringValue: cell.value },
        userEnteredFormat: format,
      };
    }),
  };
}

function autoResizeRequest(
  sheetId: number,
  startColumnIndex: number,
  endColumnIndex: number,
): sheets_v4.Schema$Request {
  return {
    autoResizeDimensions: {
      dimensions: {
        sheetId,
        dimension: 'COLUMNS',
        startIndex: startColumnIndex,
        endIndex: endColumnIndex,
      },
    },
  };
}

interface ServiceAccountCredentials {
  client_email: string;
  private_key: string;
}

function loadServiceAccountCredentials(): ServiceAccountCredentials {
  const raw = env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is not configured');
  }

  const json = raw.trim().startsWith('{') ? raw : fs.readFileSync(raw, 'utf8');

  let parsed: Partial<ServiceAccountCredentials>;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(
      'GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON (or a readable JSON key file path)',
    );
  }

  if (!parsed.client_email || !parsed.private_key) {
    throw new Error('Service account key is missing client_email or private_key');
  }

  return { client_email: parsed.client_email, private_key: parsed.private_key };
}

function countSources(jobs: ScoredJob[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const job of jobs) {
    const key = job.source || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return 'unknown error';
  }
}
