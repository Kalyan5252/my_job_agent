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
    const authMode = options.authMode ?? "auto";
    const hydratedProfile = this.resumeService.hydrateProfile(profile);
    const mode = options.mode ?? "dry-run";
    const captchaHandoff = options.captchaHandoff ?? mode === "submit";
    const captchaHandoffTimeoutMs = options.captchaHandoffTimeoutMs ?? 180_000;
    const keepBrowserOpenAfterSubmit = options.keepBrowserOpenAfterSubmit ?? (mode === "submit" && Boolean(options.preview));
    const keepBrowserOpenMs = options.keepBrowserOpenMs ?? 180_000;
    this.log(
      `start job=${job.externalId} source=${job.source} mode=${mode} authMode=${authMode} captchaHandoff=${captchaHandoff} keepOpen=${keepBrowserOpenAfterSubmit}`
    );

    if (!job.applyUrl) {
      await this.safeUpsertApplication(job, "failed", "Missing apply URL");
      this.log(`failed job=${job.externalId} reason=missing_apply_url`);
      return {
        status: "failed",
        message: "Missing apply URL",
        stage: "precheck"
      };
    }

    await this.safeUpsertApplication(job, "in_progress", `Started application in mode=${mode}`);

    try {
      if (mode === "submit") {
        const submitFlow = await this.browser.fillAndSubmitFormSingleSession(
          job.applyUrl,
          async (fields) => {
            const resumeSummary = this.resumeService.summarizeForRole(hydratedProfile);
            const mappedValues = await this.llm.mapFormFields(fields, { profile: hydratedProfile, resumeSummary, job });
            const enrichedValues = this.resumeService.enrichMappedValues(fields, mappedValues, hydratedProfile);
            const answers = this.formFiller.toAnswers(fields, enrichedValues);
            const validation = this.formFiller.validate(answers, fields);
            const missingRequiredFields = [
              ...new Set(
                validation.errors
                  .map((err) => err.replace("Missing required field: ", "").trim())
                  .filter(Boolean)
              )
            ];
            this.log(
              `map job=${job.externalId} fields=${fields.length} answers=${answers.length} required=${fields.filter((f) => f.required).length}`
            );
            return {
              answers,
              validationErrors: validation.valid ? [] : validation.errors,
              missingRequiredFields
            };
          },
          {
            preview: options.preview,
            authMode,
            captchaHandoff,
            captchaHandoffTimeoutMs,
            keepBrowserOpenAfterSubmit,
            keepBrowserOpenMs
          }
        );

        const fields = submitFlow.fields;
        const submitResult = submitFlow.result;
        if (fields.length === 0) {
          const diagnosis = await this.browser.diagnoseNoFields(job.applyUrl, {
            preview: options.preview,
            authMode,
            captchaHandoff,
            captchaHandoffTimeoutMs
          });
          const note = diagnosis.hint ? `${diagnosis.reason}. ${diagnosis.hint}` : diagnosis.reason;
          await this.safeUpsertApplication(job, "needs_human", note);
          return {
            status: "needs_human",
            message: diagnosis.reason,
            errorCode: diagnosis.code,
            stage: "extract",
            applyUrl: job.applyUrl,
            targetUrl: submitResult.targetUrl,
            previewScreenshots: submitResult.previewScreenshots
          };
        }

        if (submitFlow.validationErrors && submitFlow.validationErrors.length > 0) {
          await this.safeUpsertApplication(job, "needs_human", submitFlow.validationErrors.join("; "));
          return {
            status: "needs_human",
            message: "Validation failed for required fields",
            errorCode: "FORM_VALIDATION_FAILED",
            stage: "validate",
            requiredFieldCount: fields.filter((f) => f.required).length,
            missingRequiredFields: submitFlow.missingRequiredFields,
            applyUrl: job.applyUrl,
            targetUrl: submitResult.targetUrl,
            previewScreenshots: submitResult.previewScreenshots
          };
        }

        this.log(
          `submit job=${job.externalId} submitted=${submitResult.submitted} filled=${submitResult.filledCount} missing=${submitResult.missingSelectors.length}`
        );
        if (!submitResult.submitted) {
          const errorCode = this.inferRunErrorCode(submitResult.reason, "SUBMIT_NOT_CONFIRMED");
          await this.safeUpsertApplication(job, "needs_human", submitResult.reason);
          return {
            status: "needs_human",
            message: submitResult.reason,
            errorCode,
            stage: "submit",
            filledCount: submitResult.filledCount,
            requiredFieldCount: fields.filter((f) => f.required).length,
            missingSelectors: submitResult.missingSelectors,
            applyUrl: job.applyUrl,
            targetUrl: submitResult.targetUrl,
            previewScreenshots: submitResult.previewScreenshots
          };
        }

        await this.safeUpsertApplication(job, "applied", submitResult.reason);
        return {
          status: "applied",
          message: submitResult.reason,
          stage: "done",
          filledCount: submitResult.filledCount,
          requiredFieldCount: fields.filter((f) => f.required).length,
          missingSelectors: submitResult.missingSelectors,
          applyUrl: job.applyUrl,
          targetUrl: submitResult.targetUrl,
          previewScreenshots: submitResult.previewScreenshots
        };
      }

      let fields = await this.browser.extractFormFields(job.applyUrl, {
        preview: options.preview,
        authMode,
        captchaHandoff,
        captchaHandoffTimeoutMs
      });
      if (fields.length === 0 && this.isLinkedIn(job.applyUrl)) {
        this.log(`extract retry job=${job.externalId} reason=zero_fields`);
        await this.sleep(1200);
        fields = await this.browser.extractFormFields(job.applyUrl, {
          preview: options.preview,
          authMode,
          captchaHandoff,
          captchaHandoffTimeoutMs
        });
      }
      this.log(`extract job=${job.externalId} fields=${fields.length}`);
      if (fields.length === 0) {
        const linkedInAuthState = await this.browser.detectLinkedInAuthState(job.applyUrl);
        if (linkedInAuthState === "missing_auth") {
          const reason = "LinkedIn authenticated session missing";
          const note = `${reason}. Run npm run auth:linkedin`;
          await this.safeUpsertApplication(job, "needs_human", note);
          return {
            status: "needs_human",
            message: reason,
            errorCode: "LINKEDIN_AUTH_NOT_CONFIGURED",
            stage: "extract",
            applyUrl: job.applyUrl
          };
        }
        if (linkedInAuthState === "expired") {
          const reason = "LinkedIn session expired";
          const note = `${reason}. Refresh with npm run auth:linkedin`;
          await this.safeUpsertApplication(job, "needs_human", note);
          return {
            status: "needs_human",
            message: reason,
            errorCode: "LINKEDIN_SESSION_EXPIRED",
            stage: "extract",
            applyUrl: job.applyUrl
          };
        }

        const googleAuthState = await this.browser.detectGoogleAuthState(job.applyUrl, authMode);
        if (googleAuthState === "missing_auth") {
          const reason = "Google authenticated session missing";
          const note = `${reason}. Run npm run auth:google`;
          await this.safeUpsertApplication(job, "needs_human", note);
          return {
            status: "needs_human",
            message: reason,
            errorCode: "GOOGLE_AUTH_NOT_CONFIGURED",
            stage: "extract",
            applyUrl: job.applyUrl
          };
        }
        if (googleAuthState === "expired") {
          const reason = "Google session expired";
          const note = `${reason}. Refresh with npm run auth:google`;
          await this.safeUpsertApplication(job, "needs_human", note);
          return {
            status: "needs_human",
            message: reason,
            errorCode: "GOOGLE_SESSION_EXPIRED",
            stage: "extract",
            applyUrl: job.applyUrl
          };
        }

        const diagnosis = await this.browser.diagnoseNoFields(job.applyUrl, {
          preview: options.preview,
          authMode,
          captchaHandoff,
          captchaHandoffTimeoutMs
        });
        const note = diagnosis.hint ? `${diagnosis.reason}. ${diagnosis.hint}` : diagnosis.reason;
        await this.safeUpsertApplication(job, "needs_human", note);
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
        await this.safeUpsertApplication(job, "needs_human", reason);
        this.log(`needs_human job=${job.externalId} reason=auth_wall`);
        return {
          status: "needs_human",
          message: reason,
          errorCode: "LINKEDIN_SESSION_EXPIRED",
          stage: "extract",
          applyUrl: job.applyUrl
        };
      }

      const resumeSummary = this.resumeService.summarizeForRole(hydratedProfile);
      const mappedValues = await this.llm.mapFormFields(fields, { profile: hydratedProfile, resumeSummary, job });
      const enrichedValues = this.resumeService.enrichMappedValues(fields, mappedValues, hydratedProfile);
      const answers = this.formFiller.toAnswers(fields, enrichedValues);
      this.log(
        `map job=${job.externalId} fields=${fields.length} answers=${answers.length} required=${fields.filter((f) => f.required).length}`
      );
      const validation = this.formFiller.validate(answers, fields);
      const missingRequiredFields = [...new Set(validation.errors
        .map((err) => err.replace("Missing required field: ", "").trim())
        .filter(Boolean))];

      if (!validation.valid) {
        await this.safeUpsertApplication(job, "needs_human", validation.errors.join("; "));
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

      const fillResult = await this.browser.fillForm(job.applyUrl, answers, {
        preview: options.preview,
        authMode,
        captchaHandoff,
        captchaHandoffTimeoutMs
      });
      await this.safeUpsertApplication(job, "draft_filled", "Form filled in dry-run mode (not submitted)");
      this.log(`draft_filled job=${job.externalId} filled=${fillResult.filledCount}`);
      return {
        status: "draft_filled",
        message: "Form filled successfully in dry-run mode",
        stage: "done",
        filledCount: fillResult.filledCount,
        requiredFieldCount: fields.filter((f) => f.required).length,
        missingSelectors: fillResult.missingSelectors,
        applyUrl: job.applyUrl,
        targetUrl: fillResult.targetUrl,
        previewScreenshots: fillResult.previewScreenshots
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown failure";
      await this.safeUpsertApplication(job, "failed", message);
      this.log(`failed job=${job.externalId} reason=${message}`);
      return {
        status: "failed",
        message,
        stage: "done",
        applyUrl: job.applyUrl
      };
    }
  }

  private inferRunErrorCode(
    reason: string,
    fallback: "SUBMIT_NOT_CONFIRMED" | "NO_FORM_FIELDS"
  ): "CAPTCHA_BLOCKED" | "SUBMIT_NOT_CONFIRMED" | "NO_FORM_FIELDS" {
    const r = (reason || "").toLowerCase();
    if (
      r.includes("captcha") ||
      r.includes("hcaptcha") ||
      r.includes("human verification") ||
      r.includes("security verification")
    ) {
      return "CAPTCHA_BLOCKED";
    }
    return fallback;
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

  private async safeUpsertApplication(
    job: ScoredJob,
    status: "in_progress" | "draft_filled" | "needs_human" | "applied" | "failed",
    notes?: string
  ): Promise<void> {
    try {
      await this.upsertApplication(job, status, notes);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown db error";
      this.log(`db_upsert_failed job=${job.externalId} status=${status} reason=${message}`);
    }
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
