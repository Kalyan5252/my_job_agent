import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
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

export class DiscoveryExportService {
  async exportDiscoveryRun(input: DiscoveryExportInput): Promise<DiscoveryExportMetadata> {
    const fileName = buildDiscoveryExportFileName(input.profile.role);
    const filePath = resolveDiscoveryExportPath(fileName) ?? path.resolve(getDiscoveryExportDir(), fileName);
    const downloadUrl = `/exports/discovery/${encodeURIComponent(fileName)}`;

    if (!env.EXPORT_SPREADSHEET_ENABLED) {
      return {
        status: 'skipped',
        format: 'xlsx',
        fileName,
        filePath,
        downloadUrl,
        rowCount: input.jobs.length,
      };
    }

    try {
      await fs.promises.mkdir(getDiscoveryExportDir(), { recursive: true });

      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'my-job-agent';
      workbook.created = new Date();
      workbook.modified = new Date();
      workbook.properties.date1904 = false;

      const summarySheet = workbook.addWorksheet('Summary');
      const jobsSheet = workbook.addWorksheet('Jobs');

      this.writeSummarySheet(summarySheet, input);
      this.writeJobsSheet(jobsSheet, input.jobs);

      await workbook.xlsx.writeFile(filePath);

      return {
        status: 'created',
        format: 'xlsx',
        fileName,
        filePath,
        downloadUrl,
        rowCount: input.jobs.length,
      };
    } catch (error) {
      console.error(
        `[export] discovery spreadsheet generation failed: ${formatError(error)}`
      );

      return {
        status: 'failed',
        format: 'xlsx',
        fileName,
        filePath,
        downloadUrl,
        rowCount: input.jobs.length,
        errorMessage: formatError(error),
      };
    }
  }

  writeSummarySheet(sheet: ExcelJS.Worksheet, input: DiscoveryExportInput): void {
    sheet.columns = [
      { key: 'label', width: 28 },
      { key: 'value', width: 72 },
      { key: 'extra', width: 24 },
    ];
    sheet.views = [{ state: 'frozen', ySplit: 1 }];

    sheet.mergeCells('A1:C1');
    const titleCell = sheet.getCell('A1');
    titleCell.value = 'Discovery Export';
    titleCell.font = { bold: true, size: 15 };
    titleCell.alignment = { horizontal: 'center' };
    titleCell.fill = solidFill('1F2937');
    titleCell.font = { bold: true, color: { argb: 'FFFFFF' }, size: 15 };
    titleCell.border = thinBorder();

    let row = 3;
    row = this.writeSectionHeader(sheet, row, 'Run Details');
    row = this.writeKeyValueRows(sheet, row, [
      ['Role', input.profile.role],
      [
        'Preferred Location',
        input.searchQuery?.location ||
          input.searchQuery?.filters?.locations?.join(', ') ||
          'Any',
      ],
      ['Skills', input.profile.skills.join(', ') || 'N/A'],
      ['Experience', input.profile.experience],
      ['Total Jobs', String(input.jobs.length)],
      ['Apply Recommended', String(input.jobs.filter((job) => job.apply).length)],
    ]);

    row += 1;
    row = this.writeSectionHeader(sheet, row, 'Diagnostics');
    row = this.writeKeyValueRows(sheet, row, [
      ['API Jobs', String(input.diagnostics.counts.apiJobs)],
      ['Indian Jobs', String(input.diagnostics.counts.indianJobs)],
      ['HTML Jobs', String(input.diagnostics.counts.htmlJobs)],
      ['Browser Jobs', String(input.diagnostics.counts.browserJobs)],
      ['Merged Jobs', String(input.diagnostics.counts.mergedJobs)],
      ['Actionable Jobs', String(input.diagnostics.counts.actionableJobs)],
      ['Skill Aligned Jobs', String(input.diagnostics.counts.skillAlignedJobs)],
      ['Candidate Jobs', String(input.diagnostics.counts.candidateJobs)],
      ['Experience Aligned Jobs', String(input.diagnostics.counts.experienceAlignedJobs)],
      ['Prioritized Jobs', String(input.diagnostics.counts.prioritizedJobs)],
    ]);

    row += 1;
    row = this.writeSectionHeader(sheet, row, 'Source Breakdown');

    const sourceCounts = countSources(input.jobs);
    const sourceEntries = Object.entries(sourceCounts).sort((a, b) => b[1] - a[1]);
    const sourceHeaderRow = sheet.getRow(row);
    sourceHeaderRow.values = [undefined, 'Source', 'Jobs'];
    styleHeaderRow(sourceHeaderRow);
    row += 1;

    for (const [source, count] of sourceEntries) {
      const currentRow = sheet.getRow(row);
      currentRow.values = [undefined, source, count];
      currentRow.eachCell({ includeEmpty: true }, (cell) => {
        cell.border = thinBorder();
      });
      row += 1;
    }

    sheet.getColumn(1).width = 28;
    sheet.getColumn(2).width = 72;
    sheet.getColumn(3).width = 24;
  }

  writeJobsSheet(sheet: ExcelJS.Worksheet, jobs: ScoredJob[]): void {
    sheet.columns = [
      { header: 'Rank', key: 'rank', width: 8 },
      { header: 'Title', key: 'title', width: 28 },
      { header: 'Company', key: 'company', width: 24 },
      { header: 'Location', key: 'location', width: 24 },
      { header: 'Source', key: 'source', width: 18 },
      { header: 'Company Tier', key: 'companyTier', width: 14 },
      { header: 'Salary LPA', key: 'salaryLpa', width: 12 },
      { header: 'Score', key: 'score', width: 8 },
      { header: 'Apply', key: 'apply', width: 10 },
      { header: 'Apply URL', key: 'applyUrl', width: 48 },
      { header: 'Requirements', key: 'requirements', width: 42 },
      { header: 'Reasoning', key: 'reasoning', width: 60 },
      { header: 'External ID', key: 'externalId', width: 28 },
      { header: 'Description', key: 'description', width: 80 },
    ];
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = {
      from: 'A1',
      to: 'N1',
    };

    const header = sheet.getRow(1);
    styleHeaderRow(header);

    jobs.forEach((job, index) => {
      const row = sheet.addRow({
        rank: index + 1,
        title: job.title,
        company: job.company,
        location: job.location || '',
        source: job.source,
        companyTier: job.companyTier || '',
        salaryLpa: job.salaryLpa ?? '',
        score: job.score,
        apply: job.apply ? 'Yes' : 'No',
        applyUrl: job.applyUrl || '',
        requirements: (job.requirements || []).join(', '),
        reasoning: job.reasoning || '',
        externalId: job.externalId,
        description: job.description,
      });

      row.alignment = { vertical: 'top', wrapText: true };
      row.eachCell({ includeEmpty: true }, (cell) => {
        cell.border = thinBorder();
      });
    });
  }

  private writeSectionHeader(sheet: ExcelJS.Worksheet, rowNumber: number, title: string): number {
    const row = sheet.getRow(rowNumber);
    row.values = [undefined, title, undefined];
    row.getCell(1).fill = solidFill('E5E7EB');
    row.getCell(2).fill = solidFill('E5E7EB');
    row.getCell(3).fill = solidFill('E5E7EB');
    row.getCell(1).font = { bold: true };
    row.getCell(2).font = { bold: true };
    row.getCell(3).font = { bold: true };
    row.getCell(1).border = thinBorder();
    row.getCell(2).border = thinBorder();
    row.getCell(3).border = thinBorder();
    return rowNumber + 1;
  }

  private writeKeyValueRows(
    sheet: ExcelJS.Worksheet,
    startRow: number,
    rows: Array<[string, string]>
  ): number {
    let rowNumber = startRow;
    for (const [label, value] of rows) {
      const row = sheet.getRow(rowNumber);
      row.values = [undefined, label, value];
      row.getCell(1).border = thinBorder();
      row.getCell(2).border = thinBorder();
      row.getCell(3).border = thinBorder();
      row.getCell(1).font = { bold: true };
      row.getCell(2).alignment = { wrapText: true };
      row.getCell(3).alignment = { wrapText: true };
      rowNumber += 1;
    }

    return rowNumber;
  }
}

export function getDiscoveryExportDir(): string {
  return path.resolve(process.cwd(), env.EXPORT_SPREADSHEET_DIR);
}

export function resolveDiscoveryExportPath(fileName: string): string | null {
  if (!isSafeDiscoveryExportFileName(fileName)) return null;

  const exportDir = getDiscoveryExportDir();
  const resolved = path.resolve(exportDir, fileName);
  const relative = path.relative(exportDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;

  return resolved;
}

function buildDiscoveryExportFileName(role: string): string {
  const roleSlug = slugify(role) || 'jobs';
  const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\./g, '-');
  return `discovery-${roleSlug}-${timestamp}.xlsx`;
}

function isSafeDiscoveryExportFileName(fileName: string): boolean {
  return /^[a-z0-9._-]+\.xlsx$/i.test(fileName);
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function countSources(jobs: ScoredJob[]): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const job of jobs) {
    const key = job.source || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }

  return counts;
}

function styleHeaderRow(row: ExcelJS.Row): void {
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFF' } };
    cell.fill = solidFill('111827');
    cell.border = thinBorder();
    cell.alignment = { wrapText: true, vertical: 'middle' };
  });
}

function thinBorder(): Partial<ExcelJS.Borders> {
  return {
    top: { style: 'thin' },
    left: { style: 'thin' },
    bottom: { style: 'thin' },
    right: { style: 'thin' },
  };
}

function solidFill(color: string): ExcelJS.Fill {
  return {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: color },
  };
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
