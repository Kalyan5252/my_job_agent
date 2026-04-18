import { pgPool } from "../db/postgres/client";
import { LLMService } from "../services/llm.service";
import { ResumeService } from "../services/resume.service";
import { BrowserTool } from "../tools/browser.tool";
import { FormFillerTool } from "../tools/formFiller.tool";
import { ApplicationRunOptions, ApplicationRunResult, JobProfile, ScoredJob } from "../types";

export class ApplicationAgent {
  private readonly llm = new LLMService();
  private readonly browser = new BrowserTool();
  private readonly formFiller = new FormFillerTool();
  private readonly resumeService = new ResumeService();

  async run(
    job: ScoredJob,
    profile: JobProfile,
    options: ApplicationRunOptions = {}
  ): Promise<ApplicationRunResult> {
    const mode = options.mode ?? "dry-run";
    this.log(`start job=${job.externalId} source=${job.source} mode=${mode}`);

    if (!job.applyUrl) {
      await this.upsertApplication(job, "failed", "Missing apply URL");
      this.log(`failed job=${job.externalId} reason=missing_apply_url`);
      return {
        status: "failed",
        message: "Missing apply URL",
        stage: "precheck"
      };
    }

    await this.upsertApplication(job, "in_progress", `Started application in mode=${mode}`);

    try {
      let fields = await this.browser.extractFormFields(job.applyUrl);
      if (fields.length === 0 && this.isLinkedIn(job.applyUrl)) {
        this.log(`extract retry job=${job.externalId} reason=zero_fields`);
        await this.sleep(1200);
        fields = await this.browser.extractFormFields(job.applyUrl);
      }
      this.log(`extract job=${job.externalId} fields=${fields.length}`);
      if (fields.length === 0) {
        const authState = await this.browser.detectLinkedInAuthState(job.applyUrl);
        if (authState === "missing_auth") {
          const reason = "LinkedIn authenticated session missing";
          const note = `${reason}. Run npm run auth:linkedin`;
          await this.upsertApplication(job, "needs_human", note);
          return {
            status: "needs_human",
            message: reason,
            errorCode: "LINKEDIN_AUTH_NOT_CONFIGURED",
            stage: "extract",
            applyUrl: job.applyUrl
          };
        }
        if (authState === "expired") {
          const reason = "LinkedIn session expired";
          const note = `${reason}. Refresh with npm run auth:linkedin`;
          await this.upsertApplication(job, "needs_human", note);
          return {
            status: "needs_human",
            message: reason,
            errorCode: "LINKEDIN_SESSION_EXPIRED",
            stage: "extract",
            applyUrl: job.applyUrl
          };
        }

        const diagnosis = await this.browser.diagnoseNoFields(job.applyUrl);
        const note = diagnosis.hint ? `${diagnosis.reason}. ${diagnosis.hint}` : diagnosis.reason;
        await this.upsertApplication(job, "needs_human", note);
        this.log(`needs_human job=${job.externalId} reason=no_fields diagnosis="${diagnosis.reason}"`);
        return {
          status: "needs_human",
          message: diagnosis.reason,
          errorCode: diagnosis.code,
          stage: "extract",
          applyUrl: job.applyUrl
        };
      }
      if (this.looksLikeAuthWall(fields, job.applyUrl)) {
        const reason = "Login/auth wall detected instead of application form";
        await this.upsertApplication(job, "needs_human", reason);
        this.log(`needs_human job=${job.externalId} reason=auth_wall`);
        return {
          status: "needs_human",
          message: reason,
          errorCode: "LINKEDIN_SESSION_EXPIRED",
          stage: "extract",
          applyUrl: job.applyUrl
        };
      }

      const resumeSummary = this.resumeService.summarizeForRole(profile);
      const mappedValues = await this.llm.mapFormFields(fields, { profile, resumeSummary, job });
      const answers = this.formFiller.toAnswers(fields, mappedValues);
      const validation = this.formFiller.validate(answers, fields);
      const missingRequiredFields = [...new Set(validation.errors
        .map((err) => err.replace("Missing required field: ", "").trim())
        .filter(Boolean))];

      if (!validation.valid) {
        await this.upsertApplication(job, "needs_human", validation.errors.join("; "));
        this.log(`needs_human job=${job.externalId} reason=validation_failed`);
        return {
          status: "needs_human",
          message: "Validation failed for required fields",
          errorCode: "FORM_VALIDATION_FAILED",
          stage: "validate",
          requiredFieldCount: fields.filter((f) => f.required).length,
          missingRequiredFields,
          applyUrl: job.applyUrl
        };
      }

      if (mode === "submit") {
        const submitResult = await this.browser.fillAndSubmitForm(job.applyUrl, answers);
        this.log(
          `submit job=${job.externalId} submitted=${submitResult.submitted} filled=${submitResult.filledCount}`
        );
        if (!submitResult.submitted) {
          await this.upsertApplication(job, "needs_human", submitResult.reason);
          this.log(`needs_human job=${job.externalId} reason=${submitResult.reason}`);
          return {
            status: "needs_human",
            message: submitResult.reason,
            errorCode: "SUBMIT_NOT_CONFIRMED",
            stage: "submit",
            filledCount: submitResult.filledCount,
            requiredFieldCount: fields.filter((f) => f.required).length,
            missingSelectors: submitResult.missingSelectors,
            applyUrl: job.applyUrl
          };
        }

        await this.upsertApplication(job, "applied", submitResult.reason);
        this.log(`applied job=${job.externalId} reason=${submitResult.reason}`);
        return {
          status: "applied",
          message: submitResult.reason,
          stage: "done",
          filledCount: submitResult.filledCount,
          requiredFieldCount: fields.filter((f) => f.required).length,
          missingSelectors: submitResult.missingSelectors,
          applyUrl: job.applyUrl
        };
      }

      const fillResult = await this.browser.fillForm(job.applyUrl, answers);
      await this.upsertApplication(job, "draft_filled", "Form filled in dry-run mode (not submitted)");
      this.log(`draft_filled job=${job.externalId} filled=${fillResult.filledCount}`);
      return {
        status: "draft_filled",
        message: "Form filled successfully in dry-run mode",
        stage: "done",
        filledCount: fillResult.filledCount,
        requiredFieldCount: fields.filter((f) => f.required).length,
        missingSelectors: fillResult.missingSelectors,
        applyUrl: job.applyUrl
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown failure";
      await this.upsertApplication(job, "failed", message);
      this.log(`failed job=${job.externalId} reason=${message}`);
      return {
        status: "failed",
        message,
        stage: "done",
        applyUrl: job.applyUrl
      };
    }
  }

  private async upsertApplication(
    job: ScoredJob,
    status: "in_progress" | "draft_filled" | "needs_human" | "applied" | "failed",
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

  private log(message: string): void {
    console.log(`[application-agent] ${message}`);
  }

  private looksLikeAuthWall(fields: { name: string; label: string }[], applyUrl?: string): boolean {
    const names = fields.map((f) => `${f.name} ${f.label}`.toLowerCase()).join(" ");
    const hasAuthFields =
      names.includes("session_key") ||
      names.includes("session_password") ||
      names.includes("username") ||
      names.includes("password");

    const isLinkedin = (applyUrl || "").toLowerCase().includes("linkedin.com");
    return isLinkedin && hasAuthFields;
  }

  private isLinkedIn(url?: string): boolean {
    return (url || "").toLowerCase().includes("linkedin.com");
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
