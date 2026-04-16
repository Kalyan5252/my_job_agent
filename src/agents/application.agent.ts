import { pgPool } from "../db/postgres/client";
import { LLMService } from "../services/llm.service";
import { ResumeService } from "../services/resume.service";
import { BrowserTool } from "../tools/browser.tool";
import { FormFillerTool } from "../tools/formFiller.tool";
import { JobProfile, ScoredJob } from "../types";

export class ApplicationAgent {
  private readonly llm = new LLMService();
  private readonly browser = new BrowserTool();
  private readonly formFiller = new FormFillerTool();
  private readonly resumeService = new ResumeService();

  async run(job: ScoredJob, profile: JobProfile): Promise<void> {
    if (!job.applyUrl) {
      await this.upsertApplication(job, "failed", "Missing apply URL");
      return;
    }

    try {
      const fields = await this.browser.extractFormFields(job.applyUrl);
      const resumeSummary = this.resumeService.summarizeForRole(profile);
      const mappedValues = await this.llm.mapFormFields(fields, { profile, resumeSummary, job });
      const answers = this.formFiller.toAnswers(fields, mappedValues);
      const validation = this.formFiller.validate(answers, fields);

      if (!validation.valid) {
        await this.upsertApplication(job, "failed", validation.errors.join("; "));
        return;
      }

      await this.browser.fillForm(job.applyUrl, answers);
      await this.upsertApplication(job, "applied", "Form filled successfully");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown failure";
      await this.upsertApplication(job, "failed", message);
    }
  }

  private async upsertApplication(
    job: ScoredJob,
    status: "applied" | "failed",
    notes?: string
  ): Promise<void> {
    await pgPool.query(
      `
      INSERT INTO applications (job_external_id, source, company, role, status, notes, applied_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
      ON CONFLICT (source, job_external_id)
      DO UPDATE SET
        status = EXCLUDED.status,
        notes = EXCLUDED.notes,
        updated_at = NOW();
      `,
      [job.externalId, job.source, job.company, job.title, status, notes || null]
    );
  }
}
