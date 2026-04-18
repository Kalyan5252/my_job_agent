import fs from "node:fs";
import path from "node:path";
import { chromium, type Locator, type Page } from "playwright";
import { env } from "../config/env";
import { FieldAnswer, FormField } from "../types";

interface FillFormResult {
  filledCount: number;
  missingSelectors: string[];
}

interface SubmitResult {
  submitted: boolean;
  reason: string;
}

interface NoFieldsDiagnosis {
  code:
    | "CAPTCHA_BLOCKED"
    | "LINKEDIN_AUTH_NOT_CONFIGURED"
    | "LINKEDIN_SESSION_EXPIRED"
    | "LINKEDIN_MODAL_NOT_OPENED"
    | "EXTERNAL_APPLY_REDIRECT"
    | "NO_FORM_FIELDS";
  reason: string;
  hint?: string;
}

interface PageRunOptions {
  headless?: boolean;
  useLinkedInAuth?: boolean;
}

export class BrowserTool {
  async withPage<T>(url: string, action: (page: Page) => Promise<T>, options: PageRunOptions = {}): Promise<T> {
    const browser = await chromium.launch({ headless: options.headless ?? true });
    const context = await browser.newContext(this.resolveContextOptions(url, options));
    const page = await context.newPage();

    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      return await action(page);
    } finally {
      await page.close();
      await context.close();
      await browser.close();
    }
  }

  async extractFormFields(url: string): Promise<FormField[]> {
    return this.withPage(
      url,
      async (page) => {
        await page.waitForTimeout(1_500);

        if (this.isLinkedIn(url) && this.shouldUseLinkedInAuth()) {
          const opened = await this.openLinkedInEasyApplyModal(page);
          if (opened) {
            const modalFields = await this.extractFieldsFromLocator(page.locator('[role="dialog"]').last());
            if (modalFields.length > 0) return modalFields;
          }
        }

        return this.extractFieldsFromPage(page);
      },
      { useLinkedInAuth: this.isLinkedIn(url) }
    );
  }

  async diagnoseNoFields(url: string): Promise<NoFieldsDiagnosis> {
    return this.withPage(
      url,
      async (page) => {
        await page.waitForTimeout(1_500);
        const currentUrl = page.url().toLowerCase();
        const body = (await page.textContent("body"))?.toLowerCase() || "";

        const linkedin = currentUrl.includes("linkedin.com");
        const hasSignInForm =
          (await page.locator('input[name="session_key"], input#username, input[name="session_password"]').count()) >
          0;
        const hasEasyApplyButton = (await page.locator('button:has-text("Easy Apply")').count()) > 0;
        const hasApplyButton = (await page.locator('a:has-text("Apply"), button:has-text("Apply")').count()) > 0;
        const hasCaptchaHint =
          body.includes("captcha") || body.includes("security verification") || body.includes("verify you are human");

        if (hasCaptchaHint) {
          return {
            code: "CAPTCHA_BLOCKED",
            reason: "Blocked by CAPTCHA or security verification",
            hint: "Open this URL manually, complete verification, then retry."
          };
        }

        if (linkedin && !this.hasLinkedInAuthState()) {
          return {
            code: "LINKEDIN_AUTH_NOT_CONFIGURED",
            reason: "LinkedIn authenticated session not configured",
            hint: "Run `npm run auth:linkedin` once, then retry."
          };
        }

        if (linkedin && hasSignInForm) {
          return {
            code: "LINKEDIN_SESSION_EXPIRED",
            reason: "LinkedIn login required before accessing application form",
            hint: "Refresh LinkedIn session via `npm run auth:linkedin` and retry."
          };
        }

        if (linkedin && hasEasyApplyButton) {
          return {
            code: "LINKEDIN_MODAL_NOT_OPENED",
            reason: "Easy Apply button detected, but no input fields in current DOM",
            hint: "The form likely appears inside a post-click modal/stepper flow."
          };
        }

        if (hasApplyButton) {
          return {
            code: "EXTERNAL_APPLY_REDIRECT",
            reason: "Apply action exists but form fields are not present on this page",
            hint: "This job likely redirects to an external ATS site after clicking Apply."
          };
        }

        return {
          code: "NO_FORM_FIELDS",
          reason: "No detectable form fields on page",
          hint: "Page structure may be dynamic/unsupported. Needs human-assisted flow."
        };
      },
      { useLinkedInAuth: this.isLinkedIn(url) }
    );
  }

  async fillForm(url: string, answers: FieldAnswer[]): Promise<FillFormResult> {
    return this.withPage(
      url,
      async (page) => {
        if (this.isLinkedIn(url) && this.shouldUseLinkedInAuth()) {
          const opened = await this.openLinkedInEasyApplyModal(page);
          if (opened) {
            return this.processLinkedInEasyApplyFlow(page, answers, false);
          }
        }
        return this.fillAnswersOnPage(page, answers);
      },
      { useLinkedInAuth: this.isLinkedIn(url) }
    );
  }

  async fillAndSubmitForm(url: string, answers: FieldAnswer[]): Promise<FillFormResult & SubmitResult> {
    return this.withPage(
      url,
      async (page) => {
        if (this.isLinkedIn(url) && this.shouldUseLinkedInAuth()) {
          const opened = await this.openLinkedInEasyApplyModal(page);
          if (opened) {
            return this.processLinkedInEasyApplyFlow(page, answers, true);
          }
        }

        const fill = await this.fillAnswersOnPage(page, answers);
        const submit = await this.trySubmit(page);
        return {
          ...fill,
          submitted: submit.submitted,
          reason: submit.reason
        };
      },
      { useLinkedInAuth: this.isLinkedIn(url) }
    );
  }

  hasLinkedInAuthState(): boolean {
    if (!env.LINKEDIN_AUTH_ENABLED) return false;
    return fs.existsSync(this.linkedinStorageStatePath());
  }

  async detectLinkedInAuthState(url: string): Promise<"ok" | "expired" | "missing_auth"> {
    if (!this.isLinkedIn(url)) return "ok";
    if (!this.hasLinkedInAuthState()) return "missing_auth";

    return this.withPage(
      url,
      async (page) => {
        await page.waitForTimeout(1_000);
        const hasSignInForm =
          (await page.locator('input[name="session_key"], input#username, input[name="session_password"]').count()) >
          0;
        return hasSignInForm ? "expired" : "ok";
      },
      { useLinkedInAuth: true }
    );
  }

  private async extractFieldsFromPage(page: Page): Promise<FormField[]> {
    const raw = await page.evaluate(() => {
      const selectable = Array.from(document.querySelectorAll("input, textarea, select"));
      return selectable.map((el) => {
        const input = el as HTMLInputElement;
        return {
          name: input.name || input.id || "field",
          label:
            input.getAttribute("aria-label") ||
            input.getAttribute("name") ||
            input.getAttribute("id") ||
            "field",
          type: (input.type || input.tagName.toLowerCase()).toLowerCase(),
          required: input.required,
          placeholder: input.placeholder || undefined
        };
      });
    });
    return this.normalizeFields(raw);
  }

  private async extractFieldsFromLocator(root: Locator): Promise<FormField[]> {
    if (!(await root.count())) return [];
    const raw = await root.locator("input, textarea, select").evaluateAll((els) => {
      return els.map((el) => {
        const input = el as HTMLInputElement;
        return {
          name: input.name || input.id || "field",
          label:
            input.getAttribute("aria-label") ||
            input.getAttribute("name") ||
            input.getAttribute("id") ||
            "field",
          type: (input.type || input.tagName.toLowerCase()).toLowerCase(),
          required: input.required,
          placeholder: input.placeholder || undefined
        };
      });
    });
    return this.normalizeFields(raw);
  }

  private normalizeFields(raw: FormField[]): FormField[] {
    const blockedInputTypes = new Set(["hidden", "submit", "button", "image", "reset"]);
    const byName = new Map<string, FormField>();

    for (const field of raw) {
      const normalizedType = (field.type || "").toLowerCase();
      if (blockedInputTypes.has(normalizedType)) continue;

      const name = field.name || field.label || "field";
      const existing = byName.get(name);
      const next: FormField = {
        name,
        label: field.label || name,
        type: normalizedType || "text",
        required: Boolean(field.required),
        placeholder: field.placeholder
      };

      if (!existing) {
        byName.set(name, next);
        continue;
      }

      byName.set(name, {
        name,
        label: existing.label || next.label,
        type: existing.type || next.type,
        required: existing.required || next.required,
        placeholder: existing.placeholder || next.placeholder
      });
    }

    return Array.from(byName.values());
  }

  private async fillAnswersOnPage(page: Page, answers: FieldAnswer[]): Promise<FillFormResult> {
    let filledCount = 0;
    const missingSelectors: string[] = [];
    const modal = page.locator('[role="dialog"]').last();
    const hasModal = (await modal.count()) > 0;

    for (const answer of answers) {
      const escaped = this.escapeForSelector(answer.fieldName);
      const selector = `[name="${escaped}"], #${escaped}`;

      let target = hasModal ? modal.locator(selector).first() : page.locator(selector).first();
      if (!(await target.count()) && hasModal) {
        target = page.locator(selector).first();
      }

      if (!(await target.count())) {
        missingSelectors.push(answer.fieldName);
        continue;
      }

      const tagName = await target.evaluate((el) => el.tagName.toLowerCase());
      if (tagName === "select") {
        await target.selectOption({ label: answer.value }).catch(async () => {
          await target.selectOption({ value: answer.value }).catch(() => undefined);
        });
      } else {
        await target.fill(answer.value);
      }

      filledCount += 1;
    }

    return { filledCount, missingSelectors };
  }

  private async processLinkedInEasyApplyFlow(
    page: Page,
    answers: FieldAnswer[],
    allowSubmit: boolean
  ): Promise<FillFormResult & SubmitResult> {
    const matched = new Set<string>();
    const clickedSteps: string[] = [];
    const maxSteps = 8;

    for (let step = 0; step < maxSteps; step += 1) {
      const fill = await this.fillAnswersOnPage(page, answers);
      for (const answer of answers) {
        if (!fill.missingSelectors.includes(answer.fieldName)) {
          matched.add(answer.fieldName);
        }
      }

      const modal = page.locator('[role="dialog"]').last();
      const submitBtn = modal.locator('button:has-text("Submit application"), button:has-text("Submit")').first();
      if ((await submitBtn.count()) > 0) {
        if (!allowSubmit) {
          return {
            filledCount: matched.size,
            missingSelectors: answers
              .map((a) => a.fieldName)
              .filter((name) => !matched.has(name)),
            submitted: false,
            reason: "Reached submit step in dry-run mode; submission skipped"
          };
        }

        try {
          await submitBtn.click({ timeout: 5_000 });
          await page.waitForTimeout(2_000);
          const body = (await page.textContent("body"))?.toLowerCase() || "";
          const successSignal =
            body.includes("application submitted") || body.includes("application sent") || body.includes("thank you");
          return {
            filledCount: matched.size,
            missingSelectors: answers
              .map((a) => a.fieldName)
              .filter((name) => !matched.has(name)),
            submitted: successSignal,
            reason: successSignal ? "LinkedIn Easy Apply submitted" : "Submit clicked but no success signal detected"
          };
        } catch {
          return {
            filledCount: matched.size,
            missingSelectors: answers
              .map((a) => a.fieldName)
              .filter((name) => !matched.has(name)),
            submitted: false,
            reason: "Failed to click LinkedIn submit button"
          };
        }
      }

      const nextBtn = modal
        .locator('button:has-text("Next"), button:has-text("Review"), button:has-text("Continue")')
        .first();
      if ((await nextBtn.count()) === 0) {
        return {
          filledCount: matched.size,
          missingSelectors: answers
            .map((a) => a.fieldName)
            .filter((name) => !matched.has(name)),
          submitted: false,
          reason:
            clickedSteps.length > 0
              ? "LinkedIn Easy Apply flow ended before submit step"
              : "LinkedIn Easy Apply step controls not found"
        };
      }

      const stepText = ((await nextBtn.innerText().catch(() => "")) || "").trim();
      clickedSteps.push(stepText || "next");
      try {
        await nextBtn.click({ timeout: 5_000 });
      } catch {
        return {
          filledCount: matched.size,
          missingSelectors: answers
            .map((a) => a.fieldName)
            .filter((name) => !matched.has(name)),
          submitted: false,
          reason: "Failed while navigating LinkedIn Easy Apply steps"
        };
      }
      await page.waitForTimeout(1_000);
    }

    return {
      filledCount: matched.size,
      missingSelectors: answers
        .map((a) => a.fieldName)
        .filter((name) => !matched.has(name)),
      submitted: false,
      reason: "Reached max LinkedIn Easy Apply steps without submit"
    };
  }

  private async openLinkedInEasyApplyModal(page: Page): Promise<boolean> {
    const buttons = [
      'button:has-text("Easy Apply")',
      "button.jobs-apply-button",
      '[aria-label*="Easy Apply"]'
    ];

    for (const selector of buttons) {
      const btn = page.locator(selector).first();
      if (!(await btn.count())) continue;
      try {
        await btn.click({ timeout: 5_000 });
        await page.waitForTimeout(1_000);
        if ((await page.locator('[role="dialog"]').count()) > 0) {
          return true;
        }
      } catch {
        continue;
      }
    }

    return false;
  }

  private async trySubmit(page: Page): Promise<SubmitResult> {
    const beforeUrl = page.url();
    const submitCandidates = [
      'button:has-text("Submit application")',
      'button:has-text("Submit")',
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Review")',
      'button:has-text("Next")',
      'button:has-text("Continue")',
      'button:has-text("Apply")'
    ];

    for (const selector of submitCandidates) {
      const button = page.locator(selector).first();
      if (!(await button.count())) continue;

      try {
        await button.click({ timeout: 5_000 });
      } catch {
        continue;
      }

      await page.waitForTimeout(2_000);
      const afterUrl = page.url();
      const body = (await page.textContent("body"))?.toLowerCase() || "";
      const successSignal =
        afterUrl !== beforeUrl ||
        body.includes("thank you") ||
        body.includes("application submitted") ||
        body.includes("we have received") ||
        body.includes("application sent");

      if (successSignal) {
        return { submitted: true, reason: "Submission signal detected" };
      }
    }

    return { submitted: false, reason: "No submit control detected on page" };
  }

  private resolveContextOptions(url: string, options: PageRunOptions): { storageState?: string } {
    if (!options.useLinkedInAuth || !this.isLinkedIn(url)) return {};
    if (!this.shouldUseLinkedInAuth()) return {};
    const storageState = this.linkedinStorageStatePath();
    if (!fs.existsSync(storageState)) return {};
    return { storageState };
  }

  private shouldUseLinkedInAuth(): boolean {
    return env.LINKEDIN_AUTH_ENABLED && this.hasLinkedInAuthState();
  }

  private linkedinStorageStatePath(): string {
    const configured = env.LINKEDIN_STORAGE_STATE_PATH;
    return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
  }

  private isLinkedIn(url: string): boolean {
    return url.toLowerCase().includes("linkedin.com");
  }

  private escapeForSelector(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }
}
