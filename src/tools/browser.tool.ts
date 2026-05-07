import fs from 'node:fs';
import path from 'node:path';
import { chromium,firefox, type BrowserContextOptions, type Locator, type Page } from 'playwright';
import { env } from '../config/env';
import { FieldAnswer, FormField } from '../types';

interface FillFormResult {
  filledCount: number;
  missingSelectors: string[];
  targetUrl?: string;
  previewScreenshots?: string[];
  blockerCode?: 'CAPTCHA_BLOCKED';
  blockerReason?: string;
}

interface SubmitResult {
  submitted: boolean;
  reason: string;
}

interface AnswerResolution {
  answers: FieldAnswer[];
  validationErrors?: string[];
  missingRequiredFields?: string[];
}

interface NoFieldsDiagnosis {
  code:
    | 'CAPTCHA_BLOCKED'
    | 'LINKEDIN_AUTH_NOT_CONFIGURED'
    | 'LINKEDIN_SESSION_EXPIRED'
    | 'GOOGLE_AUTH_NOT_CONFIGURED'
    | 'GOOGLE_SESSION_EXPIRED'
    | 'GOOGLE_AUTH_REQUIRED'
    | 'LINKEDIN_MODAL_NOT_OPENED'
    | 'EXTERNAL_APPLY_REDIRECT'
    | 'NO_FORM_FIELDS';
  reason: string;
  hint?: string;
}

interface PageRunOptions {
  headless?: boolean;
  useLinkedInAuth?: boolean;
  useGoogleAuth?: boolean;
  authMode?: 'auto' | 'google' | 'linkedin';
  preview?: boolean;
  captchaHandoff?: boolean;
  captchaHandoffTimeoutMs?: number;
  keepBrowserOpenAfterSubmit?: boolean;
  keepBrowserOpenMs?: number;
}

interface IdentityContext {
  useSecondary: boolean;
  email: string;
  resumePath: string;
  name?: string;
  linkedin?: string;
  github?: string;
  phone?: string;
}

export class BrowserTool {
  async withPage<T>(
    url: string,
    action: (page: Page) => Promise<T>,
    options: PageRunOptions = {},
  ): Promise<T> {
    const preview = options.preview ?? false;
    const requiresInteractiveBrowser = preview || Boolean(options.captchaHandoff);
    let browser;
    try{
     browser = await chromium.launch({
      headless: requiresInteractiveBrowser ? false : (options.headless ?? true),
      slowMo: preview ? 120 : 0,
    });
  }
  catch (error) {
    try {
      console.warn('Chromium launch failed, falling back to Firefox. Original error:', error);
      browser = await firefox.launch({
        headless: requiresInteractiveBrowser ? false : (options.headless ?? true),
        slowMo: preview ? 120 : 0,
      });
    } catch(error){
      throw new Error(`Failed to launch both Chromium and Firefox browsers. Original error: ${error}`);
    }
  }
    const context = await browser.newContext(this.resolveContextOptions(url, options));
    const page = await context.newPage();

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      return await action(page);
    } finally {
      if (options.keepBrowserOpenAfterSubmit) {
        const holdMs = Math.max(5_000, Math.min(options.keepBrowserOpenMs ?? 180_000, 900_000));
        this.log(
          `post-submit hold enabled; keeping browser open for ${Math.round(holdMs / 1000)}s`,
        );
        await page.waitForTimeout(holdMs);
      }
      await page.close();
      await context.close();
      await browser.close();
    }
  }

  async extractFormFields(
    url: string,
    options: {
      preview?: boolean;
      authMode?: 'auto' | 'google' | 'linkedin';
      captchaHandoff?: boolean;
      captchaHandoffTimeoutMs?: number;
    } = {},
  ): Promise<FormField[]> {
    return this.withPage(
      url,
      async (page) => {
        await page.waitForTimeout(1_500);

        if (this.isLinkedIn(url) && this.shouldUseLinkedInAuth()) {
          const opened = await this.openLinkedInEasyApplyModal(page);
          if (opened) {
            const modalFields = await this.extractFieldsFromLocator(
              page.locator('[role="dialog"]').last(),
            );
            if (modalFields.length > 0) return modalFields;
          }

          const externalPage = await this.openLinkedInExternalApply(page);
          if (externalPage) {
            await externalPage.waitForTimeout(1_000);
            const activePage = await this.prepareExternalApplyPage(externalPage);
            return this.extractFieldsFromPage(activePage);
          }
        }

        return this.extractFieldsFromPage(page);
      },
      {
        useLinkedInAuth: this.isLinkedIn(url),
        useGoogleAuth: true,
        authMode: options.authMode,
        preview: options.preview,
        captchaHandoff: options.captchaHandoff,
        captchaHandoffTimeoutMs: options.captchaHandoffTimeoutMs,
      },
    );
  }

  async diagnoseNoFields(
    url: string,
    options: {
      preview?: boolean;
      authMode?: 'auto' | 'google' | 'linkedin';
      captchaHandoff?: boolean;
      captchaHandoffTimeoutMs?: number;
    } = {},
  ): Promise<NoFieldsDiagnosis> {
    return this.withPage(
      url,
      async (page) => {
        await page.waitForTimeout(1_500);
        const currentUrl = page.url().toLowerCase();
        const body = (await page.textContent('body'))?.toLowerCase() || '';

        const linkedin = currentUrl.includes('linkedin.com');
        const hasSignInForm =
          (await page
            .locator('input[name="session_key"], input#username, input[name="session_password"]')
            .count()) > 0;
        const hasEasyApplyButton =
          (await page.locator('button:has-text("Easy Apply")').count()) > 0;
        const hasApplyButton =
          (await page.locator('a:has-text("Apply"), button:has-text("Apply")').count()) > 0;
        const hasCaptchaHint =
          body.includes('captcha') ||
          body.includes('security verification') ||
          body.includes('verify you are human');

        if (hasCaptchaHint) {
          return {
            code: 'CAPTCHA_BLOCKED',
            reason: 'Blocked by CAPTCHA or security verification',
            hint: 'Open this URL manually, complete verification, then retry.',
          };
        }

        if (linkedin && !this.hasLinkedInAuthState()) {
          return {
            code: 'LINKEDIN_AUTH_NOT_CONFIGURED',
            reason: 'LinkedIn authenticated session not configured',
            hint: 'Run `npm run auth:linkedin` once, then retry.',
          };
        }

        if (linkedin && hasSignInForm) {
          return {
            code: 'LINKEDIN_SESSION_EXPIRED',
            reason: 'LinkedIn login required before accessing application form',
            hint: 'Refresh LinkedIn session via `npm run auth:linkedin` and retry.',
          };
        }

        const googleAuth = await this.isGoogleAuthContext(page);
        if (googleAuth && !this.hasGoogleAuthState()) {
          return {
            code: 'GOOGLE_AUTH_NOT_CONFIGURED',
            reason: 'Google authenticated session not configured',
            hint: 'Run `npm run auth:google` once, then retry.',
          };
        }
        if (googleAuth && hasSignInForm) {
          return {
            code: 'GOOGLE_SESSION_EXPIRED',
            reason: 'Google login required before accessing application form',
            hint: 'Refresh Google session via `npm run auth:google` and retry.',
          };
        }
        if (googleAuth) {
          return {
            code: 'GOOGLE_AUTH_REQUIRED',
            reason: 'Application flow requires Google sign-in',
            hint: 'Use saved Google session or refresh it via `npm run auth:google`.',
          };
        }

        if (linkedin && hasEasyApplyButton) {
          return {
            code: 'LINKEDIN_MODAL_NOT_OPENED',
            reason: 'Easy Apply button detected, but no input fields in current DOM',
            hint: 'The form likely appears inside a post-click modal/stepper flow.',
          };
        }

        if (hasApplyButton) {
          return {
            code: 'EXTERNAL_APPLY_REDIRECT',
            reason: 'Apply action exists but form fields are not present on this page',
            hint: 'This job likely redirects to an external ATS site after clicking Apply.',
          };
        }

        return {
          code: 'NO_FORM_FIELDS',
          reason: 'No detectable form fields on page',
          hint: 'Page structure may be dynamic/unsupported. Needs human-assisted flow.',
        };
      },
      {
        useLinkedInAuth: this.isLinkedIn(url),
        useGoogleAuth: true,
        authMode: options.authMode,
        preview: options.preview,
        captchaHandoff: options.captchaHandoff,
        captchaHandoffTimeoutMs: options.captchaHandoffTimeoutMs,
      },
    );
  }

  async fillForm(
    url: string,
    answers: FieldAnswer[],
    options: {
      preview?: boolean;
      authMode?: 'auto' | 'google' | 'linkedin';
      captchaHandoff?: boolean;
      captchaHandoffTimeoutMs?: number;
    } = {},
  ): Promise<FillFormResult> {
    return this.withPage(
      url,
      async (page) => {
        const previews: string[] = [];
        if (this.isLinkedIn(url) && this.shouldUseLinkedInAuth()) {
          const opened = await this.openLinkedInEasyApplyModal(page);
          if (opened) {
            const result = await this.processLinkedInEasyApplyFlow(page, answers, false);
            return { ...result, previewScreenshots: previews };
          }

          const externalPage = await this.openLinkedInExternalApply(page);
          if (externalPage) {
            if (options.preview)
              previews.push(await this.capturePreview(externalPage, 'external-opened'));
            const activePage = await this.prepareExternalApplyPage(externalPage);
            if (options.preview)
              previews.push(await this.capturePreview(activePage, 'external-apply-clicked'));
            const fill = await this.fillAnswersOnPage(activePage, answers);
            if (options.preview)
              previews.push(await this.capturePreview(activePage, 'external-filled'));
            return {
              ...fill,
              targetUrl: activePage.url(),
              previewScreenshots: previews.filter(Boolean),
            };
          }
        }

        const fill = await this.fillAnswersOnPage(page, answers);
        if (options.preview) previews.push(await this.capturePreview(page, 'filled'));
        return {
          ...fill,
          targetUrl: page.url(),
          previewScreenshots: previews.filter(Boolean),
        };
      },
      {
        useLinkedInAuth: this.isLinkedIn(url),
        useGoogleAuth: true,
        authMode: options.authMode,
        preview: options.preview,
        captchaHandoff: options.captchaHandoff,
        captchaHandoffTimeoutMs: options.captchaHandoffTimeoutMs,
      },
    );
  }

  async fillAndSubmitForm(
    url: string,
    answers: FieldAnswer[],
    options: {
      preview?: boolean;
      authMode?: 'auto' | 'google' | 'linkedin';
      captchaHandoff?: boolean;
      captchaHandoffTimeoutMs?: number;
      keepBrowserOpenAfterSubmit?: boolean;
      keepBrowserOpenMs?: number;
    } = {},
  ): Promise<FillFormResult & SubmitResult> {
    return this.withPage(
      url,
      async (page) => {
        const previews: string[] = [];
        const identity = await this.resolveIdentityContext(page);
        if (this.isLinkedIn(url) && this.shouldUseLinkedInAuth()) {
          const opened = await this.openLinkedInEasyApplyModal(page);
          if (opened) {
            const result = await this.processLinkedInEasyApplyFlow(page, answers, true);
            return {
              ...result,
              targetUrl: page.url(),
              previewScreenshots: previews,
            };
          }

          const externalPage = await this.openLinkedInExternalApply(page);
          if (externalPage) {
            if (options.preview)
              previews.push(await this.capturePreview(externalPage, 'external-opened'));
            const activePage = await this.prepareExternalApplyPage(externalPage);
            if (options.preview)
              previews.push(await this.capturePreview(activePage, 'external-apply-clicked'));
            const fill = await this.fillAnswersOnPage(activePage, answers);
            if (options.preview)
              previews.push(await this.capturePreview(activePage, 'external-filled'));
            const submit = await this.tryExternalSubmit(activePage, {
              ...options,
              resumePath: identity.resumePath,
            });
            if (options.preview)
              previews.push(await this.capturePreview(activePage, 'external-submitted'));
            return {
              ...fill,
              submitted: submit.submitted,
              reason: submit.reason,
              targetUrl: activePage.url(),
              previewScreenshots: previews.filter(Boolean),
            };
          }
        }

        const fill = await this.fillAnswersOnPage(page, answers);
        const submit = await this.trySubmit(page, {
          ...options,
          resumePath: identity.resumePath,
        });
        if (options.preview) previews.push(await this.capturePreview(page, 'submitted'));
        return {
          ...fill,
          submitted: submit.submitted,
          reason: submit.reason,
          targetUrl: page.url(),
          previewScreenshots: previews.filter(Boolean),
        };
      },
      {
        useLinkedInAuth: this.isLinkedIn(url),
        useGoogleAuth: true,
        authMode: options.authMode,
        preview: options.preview,
        captchaHandoff: options.captchaHandoff,
        captchaHandoffTimeoutMs: options.captchaHandoffTimeoutMs,
        keepBrowserOpenAfterSubmit: options.keepBrowserOpenAfterSubmit,
        keepBrowserOpenMs: options.keepBrowserOpenMs,
      },
    );
  }

  async fillAndSubmitFormSingleSession(
    url: string,
    resolver: (fields: FormField[]) => Promise<AnswerResolution>,
    options: {
      preview?: boolean;
      authMode?: 'auto' | 'google' | 'linkedin';
      captchaHandoff?: boolean;
      captchaHandoffTimeoutMs?: number;
      keepBrowserOpenAfterSubmit?: boolean;
      keepBrowserOpenMs?: number;
    } = {},
  ): Promise<{
    fields: FormField[];
    result: FillFormResult & SubmitResult;
    validationErrors?: string[];
    missingRequiredFields?: string[];
  }> {
    return this.withPage(
      url,
      async (page) => {
        const previews: string[] = [];
        const identity = await this.resolveIdentityContext(page);

        const runOnPage = async (
          activePage: Page,
          external: boolean,
        ): Promise<{
          fields: FormField[];
          result: FillFormResult & SubmitResult;
          validationErrors?: string[];
          missingRequiredFields?: string[];
        }> => {
          const fields = await this.extractFieldsFromPage(activePage);
          if (fields.length === 0) {
            return {
              fields,
              result: {
                submitted: false,
                reason: 'No form fields discovered on application page',
                filledCount: 0,
                missingSelectors: [],
                targetUrl: activePage.url(),
                previewScreenshots: previews.filter(Boolean),
              },
            };
          }

          const resolved = await resolver(fields);
          if (resolved.validationErrors && resolved.validationErrors.length > 0) {
            return {
              fields,
              validationErrors: resolved.validationErrors,
              missingRequiredFields: resolved.missingRequiredFields,
              result: {
                submitted: false,
                reason: 'Validation failed for required fields',
                filledCount: 0,
                missingSelectors: [],
                targetUrl: activePage.url(),
                previewScreenshots: previews.filter(Boolean),
              },
            };
          }

          const fill = await this.fillAnswersOnPage(activePage, resolved.answers);
          const submit = external
            ? await this.tryExternalSubmit(activePage, {
                ...options,
                resumePath: identity.resumePath,
              })
            : await this.trySubmit(activePage, {
                ...options,
                resumePath: identity.resumePath,
              });
          return {
            fields,
            result: {
              ...fill,
              ...submit,
              targetUrl: activePage.url(),
              previewScreenshots: previews.filter(Boolean),
            },
          };
        };

        if (this.isLinkedIn(url) && this.shouldUseLinkedInAuth()) {
          const opened = await this.openLinkedInEasyApplyModal(page);
          if (opened) {
            const modal = page.locator('[role="dialog"]').last();
            const fields = await this.extractFieldsFromLocator(modal);
            if (fields.length === 0) {
              return {
                fields,
                result: {
                  submitted: false,
                  reason: 'No form fields discovered on application page',
                  filledCount: 0,
                  missingSelectors: [],
                  targetUrl: page.url(),
                  previewScreenshots: previews,
                },
              };
            }

            const resolved = await resolver(fields);
            if (resolved.validationErrors && resolved.validationErrors.length > 0) {
              return {
                fields,
                validationErrors: resolved.validationErrors,
                missingRequiredFields: resolved.missingRequiredFields,
                result: {
                  submitted: false,
                  reason: 'Validation failed for required fields',
                  filledCount: 0,
                  missingSelectors: [],
                  targetUrl: page.url(),
                  previewScreenshots: previews,
                },
              };
            }
            const easyApply = await this.processLinkedInEasyApplyFlow(page, resolved.answers, true);
            return {
              fields,
              result: {
                ...easyApply,
                targetUrl: page.url(),
                previewScreenshots: previews.filter(Boolean),
              },
            };
          }

          const externalPage = await this.openLinkedInExternalApply(page);
          if (externalPage) {
            if (options.preview)
              previews.push(await this.capturePreview(externalPage, 'external-opened'));
            const activePage = await this.prepareExternalApplyPage(externalPage);
            if (options.preview)
              previews.push(await this.capturePreview(activePage, 'external-apply-clicked'));
            const done = await runOnPage(activePage, true);
            if (options.preview)
              previews.push(await this.capturePreview(activePage, 'external-submitted'));
            done.result.previewScreenshots = previews.filter(Boolean);
            return done;
          }
        }

        if (options.preview) previews.push(await this.capturePreview(page, 'opened'));
        const done = await runOnPage(page, false);
        if (options.preview) previews.push(await this.capturePreview(page, 'submitted'));
        done.result.previewScreenshots = previews.filter(Boolean);
        return done;
      },
      {
        useLinkedInAuth: this.isLinkedIn(url),
        useGoogleAuth: true,
        authMode: options.authMode,
        preview: options.preview,
        captchaHandoff: options.captchaHandoff,
        captchaHandoffTimeoutMs: options.captchaHandoffTimeoutMs,
        keepBrowserOpenAfterSubmit: options.keepBrowserOpenAfterSubmit,
        keepBrowserOpenMs: options.keepBrowserOpenMs,
      },
    );
  }

  hasLinkedInAuthState(): boolean {
    if (!env.LINKEDIN_AUTH_ENABLED) return false;
    return fs.existsSync(this.linkedinStorageStatePath());
  }

  hasGoogleAuthState(): boolean {
    if (!env.GOOGLE_AUTH_ENABLED) return false;
    return fs.existsSync(this.googleStorageStatePath());
  }

  async detectLinkedInAuthState(url: string): Promise<'ok' | 'expired' | 'missing_auth'> {
    if (!this.isLinkedIn(url)) return 'ok';
    if (!this.hasLinkedInAuthState()) return 'missing_auth';

    return this.withPage(
      url,
      async (page) => {
        await page.waitForTimeout(1_000);
        const hasSignInForm =
          (await page
            .locator('input[name="session_key"], input#username, input[name="session_password"]')
            .count()) > 0;
        return hasSignInForm ? 'expired' : 'ok';
      },
      { useLinkedInAuth: true },
    );
  }

  async detectGoogleAuthState(
    url: string,
    authMode: 'auto' | 'google' | 'linkedin' = 'auto',
  ): Promise<'ok' | 'expired' | 'missing_auth'> {
    if (authMode === 'linkedin') return 'ok';
    const shouldProbe = authMode === 'google' || this.looksGoogleRelatedUrl(url);
    if (!shouldProbe) return 'ok';
    if (!this.hasGoogleAuthState()) return 'missing_auth';

    return this.withPage(
      url,
      async (page) => {
        await page.waitForTimeout(1000);
        const needsGoogle = await this.isGoogleAuthContext(page);
        if (!needsGoogle) return 'ok';
        const current = page.url().toLowerCase();
        const onSignIn = current.includes('accounts.google.com');
        return onSignIn ? 'expired' : 'ok';
      },
      { useGoogleAuth: true, authMode },
    );
  }

  private async extractFieldsFromPage(page: Page): Promise<FormField[]> {
    const raw = await page.evaluate(() => {
      const selectable = Array.from(document.querySelectorAll('input, textarea, select'));
      return selectable.map((el) => {
        const input = el as HTMLInputElement;
        const ariaLabel = input.getAttribute('aria-label') || '';
        const placeholder = input.placeholder || '';
        const fallbackKey = ariaLabel || placeholder || 'field';
        return {
          name: input.name || input.id || fallbackKey,
          label: ariaLabel || input.getAttribute('name') || input.getAttribute('id') || fallbackKey,
          type: (input.type || input.tagName.toLowerCase()).toLowerCase(),
          required: input.required,
          placeholder: placeholder || undefined,
        };
      });
    });
    return this.normalizeFields(raw);
  }

  private async extractFieldsFromLocator(root: Locator): Promise<FormField[]> {
    if (!(await root.count())) return [];
    const raw = await root.locator('input, textarea, select').evaluateAll((els) => {
      return els.map((el) => {
        const input = el as HTMLInputElement;
        const ariaLabel = input.getAttribute('aria-label') || '';
        const placeholder = input.placeholder || '';
        const fallbackKey = ariaLabel || placeholder || 'field';
        return {
          name: input.name || input.id || fallbackKey,
          label: ariaLabel || input.getAttribute('name') || input.getAttribute('id') || fallbackKey,
          type: (input.type || input.tagName.toLowerCase()).toLowerCase(),
          required: input.required,
          placeholder: placeholder || undefined,
        };
      });
    });
    return this.normalizeFields(raw);
  }

  private normalizeFields(raw: FormField[]): FormField[] {
    const blockedInputTypes = new Set(['hidden', 'submit', 'button', 'image', 'reset']);
    const byName = new Map<string, FormField>();

    for (const field of raw) {
      const normalizedType = (field.type || '').toLowerCase();
      if (blockedInputTypes.has(normalizedType)) continue;

      const name = field.name || field.label || 'field';
      const existing = byName.get(name);
      const next: FormField = {
        name,
        label: field.label || name,
        type: normalizedType || 'text',
        required: Boolean(field.required),
        placeholder: field.placeholder,
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
        placeholder: existing.placeholder || next.placeholder,
      });
    }

    return Array.from(byName.values());
  }

  private async fillAnswersOnPage(page: Page, answers: FieldAnswer[]): Promise<FillFormResult> {
    const blocker = await this.detectHumanVerification(page);
    if (blocker.blocked) {
      return {
        filledCount: 0,
        missingSelectors: [],
        blockerCode: 'CAPTCHA_BLOCKED',
        blockerReason: blocker.reason || 'Human verification required',
      };
    }

    const identity = await this.resolveIdentityContext(page);
    let filledCount = 0;
    const missingSelectors: string[] = [];
    const modal = page.locator('[role="dialog"]').last();
    const hasModal = (await modal.count()) > 0;

    for (const answer of answers) {
      const target = await this.findTargetInput(page, hasModal ? modal : null, answer.fieldName);

      if (!target || !(await target.count())) {
        missingSelectors.push(answer.fieldName);
        continue;
      }

      const tagName = await target.evaluate((el) => el.tagName.toLowerCase());
      const inputType = await target
        .evaluate((el) => ((el as HTMLInputElement).type || '').toLowerCase())
        .catch(() => '');
      const fieldNameLower = answer.fieldName.toLowerCase();
      let value = answer.value;
      const fieldContextText = await this.extractFieldContextText(page, target);
      const labelText = `${fieldNameLower} ${fieldContextText}`.toLowerCase();
      value = this.overrideAnswerByContext(labelText, value);

      if (
        identity.useSecondary &&
        (inputType === 'email' ||
          fieldNameLower.includes('email') ||
          fieldNameLower.includes('mail') ||
          fieldNameLower.includes('google'))
      ) {
        value = identity.email;
      }
      if (
        identity.useSecondary &&
        (fieldNameLower.includes('name') || labelText.includes('full_name'))
      ) {
        value = identity.name || value;
      }
      if (identity.useSecondary && fieldNameLower.includes('linkedin')) {
        value = identity.linkedin || value;
      }
      if (identity.useSecondary && fieldNameLower.includes('github')) {
        value = identity.github || value;
      }
      if (
        identity.useSecondary &&
        (fieldNameLower.includes('phone') ||
          fieldNameLower.includes('mobile') ||
          inputType === 'tel')
      ) {
        value = identity.phone || value;
      }

      const isEmailField =
        inputType === 'email' ||
        fieldNameLower.includes('email') ||
        fieldNameLower.includes('mail');
      const isPhoneField =
        inputType === 'tel' ||
        fieldNameLower.includes('phone') ||
        fieldNameLower.includes('mobile');
      if (isEmailField || isPhoneField) {
        const currentValue = await this.readInputValue(target);
        const primaryContact = this.loadPrimaryContactData();

        if (isEmailField) {
          const preferredEmail = identity.email || primaryContact.email || '';
          if (this.looksValidEmail(currentValue)) {
            value = currentValue;
          } else if (this.looksValidEmail(preferredEmail)) {
            value = preferredEmail;
          }
        }

        if (isPhoneField) {
          const preferredPhone = identity.phone || primaryContact.phone || '';
          if (this.looksValidPhone(currentValue) && !this.isSuspiciousPhone(currentValue)) {
            value = currentValue;
          } else if (this.looksValidPhone(preferredPhone)) {
            value = preferredPhone;
          }
        }
      }

      if (inputType === 'file') {
        const uploaded = await this.attachResumeToInput(target, identity.resumePath);
        if (!uploaded) {
          missingSelectors.push(answer.fieldName);
          continue;
        }
        filledCount += 1;
        continue;
      }

      if (inputType === 'checkbox') {
        const contextualName = `${answer.fieldName} ${fieldContextText}`.toLowerCase();

        if (
          contextualName.includes('non-compete') ||
          contextualName.includes('non compete') ||
          contextualName.includes('prevent you from working')
        ) {
          value = 'No';
        }

        const binarySelected = await this.trySelectBinaryCheckboxOption(
          page,
          hasModal ? modal : null,
          target,
          value,
        );
        if (binarySelected !== null) {
          if (binarySelected) {
            filledCount += 1;
          } else {
            missingSelectors.push(answer.fieldName);
          }
          continue;
        }

        const defaultCheckboxValue = this.shouldDefaultCheckboxToTrue(contextualName);
        const shouldCheck = this.toBooleanAnswer(value, defaultCheckboxValue);
        const toggled = await this.toggleCheckboxWithFallback(page, target, shouldCheck);
        if (!toggled) {
          missingSelectors.push(answer.fieldName);
          continue;
        }
        filledCount += 1;
        continue;
      }

      if (inputType === 'radio') {
        const selected = await this.selectRadioOption(page, modal, target, answer.fieldName, value);
        if (selected) {
          filledCount += 1;
        } else {
          missingSelectors.push(answer.fieldName);
        }
        continue;
      }

      if (tagName === 'select') {
        await target.selectOption({ label: value }).catch(async () => {
          await target.selectOption({ value }).catch(() => undefined);
        });
      } else {
        if (!(await target.isVisible().catch(() => false))) {
          missingSelectors.push(answer.fieldName);
          continue;
        }
        await target.fill(value);
      }

      filledCount += 1;
    }

    const autoAttached = await this.autoAttachResumeIfAny(page, identity.resumePath);
    filledCount += autoAttached;
    const contextualFilled = await this.autoFillContextualQuestions(page, hasModal ? modal : null);
    filledCount += contextualFilled;
    const requiredFiles = await this.findMissingRequiredFileInputs(page);
    for (const missing of requiredFiles) {
      if (!missingSelectors.includes(missing)) {
        missingSelectors.push(missing);
      }
    }

    return { filledCount, missingSelectors };
  }

  private async autoFillContextualQuestions(page: Page, modal: Locator | null): Promise<number> {
    const identity = this.loadPrimaryIdentityData();
    const skills = identity.skills || [];
    const skillYears = identity.skillYears || {};
    const root = modal && (await modal.count().catch(() => 0)) > 0 ? modal : page.locator('body');
    const rootHandle = await root.elementHandle();
    if (!rootHandle) return 0;

    const filled = await rootHandle.evaluate(
      (el, data) => {
        const rootEl = el as HTMLElement;
        const profileSkills = (data?.skills || []) as string[];
        const explicitYears = (data?.skillYears || {}) as Record<string, number>;

        const normalize = (v: string) =>
          (v || '')
            .toLowerCase()
            .replace(/[\(\)\[\],]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .replace('react js', 'react')
            .replace('react.js', 'react')
            .replace('vue js', 'vue')
            .replace('vue.js', 'vue')
            .replace('node js', 'node.js')
            .replace('nodejs', 'node.js')
            .replace('express js', 'express.js')
            .replace('next js', 'next.js');

        const dispatch = (node: HTMLInputElement) => {
          node.dispatchEvent(new Event('input', { bubbles: true }));
          node.dispatchEvent(new Event('change', { bubbles: true }));
          node.dispatchEvent(new Event('blur', { bubbles: true }));
        };

        const inferYears = (skill: string): number => {
          const normalized = normalize(skill);
          if (!normalized) return 0;
          for (const [k, v] of Object.entries(explicitYears)) {
            if (normalize(k) === normalized) return Math.max(0, Math.floor(v as number));
          }
          const set = new Set(profileSkills.map(normalize));
          return set.has(normalized) ? 1 : 0;
        };

        let changed = 0;
        const textNodes = Array.from(rootEl.querySelectorAll('label, legend, p, span, div'));
        for (const node of textNodes) {
          const text = (node.textContent || '').trim();
          if (!text) continue;
          const lower = text.toLowerCase();

          if (
            lower.includes('have you completed the following level of education') ||
            lower.includes("bachelor's degree") ||
            lower.includes('bachelors degree')
          ) {
            const container = (node.closest('fieldset') ||
              node.parentElement ||
              rootEl) as HTMLElement;
            const options = Array.from(
              container.querySelectorAll('input[type="radio"], input[type="checkbox"]'),
            ) as HTMLInputElement[];
            let picked = false;
            for (const input of options) {
              const id = input.id || '';
              const forLabel = id ? container.querySelector(`label[for="${id}"]`) : null;
              const parentLabel = input.closest('label');
              const optionText = `${input.value || ''} ${input.getAttribute('aria-label') || ''} ${
                (forLabel?.textContent || '') as string
              } ${(parentLabel?.textContent || '') as string}`.toLowerCase();
              if (
                optionText.includes('yes') ||
                optionText.includes('true') ||
                optionText.includes('1')
              ) {
                input.checked = true;
                dispatch(input);
                changed += 1;
                picked = true;
                break;
              }
            }
            if (!picked && options.length > 0) {
              options[0].checked = true;
              dispatch(options[0]);
              changed += 1;
            }
          }

          const yearsMatch = lower.match(
            /how many years of work experience do you have with\s+([a-z0-9.+#/\-\s]+)\??/i,
          );
          if (yearsMatch?.[1]) {
            const skill = yearsMatch[1];
            const years = inferYears(skill);
            const container = (node.closest('fieldset') ||
              node.parentElement ||
              rootEl) as HTMLElement;
            const input =
              (container.querySelector('input[type="number"]') as HTMLInputElement | null) ||
              (container.querySelector('input[type="text"]') as HTMLInputElement | null) ||
              (container.querySelector('input:not([type])') as HTMLInputElement | null);
            if (input) {
              input.value = String(years);
              dispatch(input);
              changed += 1;
            }
          }
        }
        return changed;
      },
      { skills, skillYears },
    );

    return filled || 0;
  }

  private async processLinkedInEasyApplyFlow(
    page: Page,
    answers: FieldAnswer[],
    allowSubmit: boolean,
  ): Promise<FillFormResult & SubmitResult> {
    const matched = new Set<string>();
    const clickedSteps: string[] = [];
    const maxSteps = 12;

    for (let step = 0; step < maxSteps; step += 1) {
      const fill = await this.fillAnswersOnPage(page, answers);
      for (const answer of answers) {
        if (!fill.missingSelectors.includes(answer.fieldName)) {
          matched.add(answer.fieldName);
        }
      }

      const modal = page.locator('[role="dialog"]').last();
      if ((await modal.count()) === 0) {
        const body = (await page.textContent('body').catch(() => ''))?.toLowerCase() || '';
        const successSignal =
          body.includes('application submitted') ||
          body.includes('application sent') ||
          body.includes('your application was sent') ||
          body.includes('thank you');
        return {
          filledCount: matched.size,
          missingSelectors: answers.map((a) => a.fieldName).filter((name) => !matched.has(name)),
          submitted: successSignal,
          reason: successSignal
            ? 'LinkedIn Easy Apply submitted'
            : 'Easy Apply modal closed unexpectedly',
        };
      }

      const snapshotBefore = await this.getLinkedInModalSnapshot(modal);
      const submitBtn = await this.findFirstEnabledButton(modal, [
        'button:has-text("Submit application")',
        'button:has-text("Submit")',
      ]);
      if (submitBtn) {
        if (!allowSubmit) {
          return {
            filledCount: matched.size,
            missingSelectors: answers.map((a) => a.fieldName).filter((name) => !matched.has(name)),
            submitted: false,
            reason: 'Reached submit step in dry-run mode; submission skipped',
          };
        }

        try {
          await submitBtn.click({ timeout: 5_000 });
          await this.waitForLinkedInModalTransition(page, modal, snapshotBefore, 2500);
          const body = (await page.textContent('body'))?.toLowerCase() || '';
          const successSignal =
            body.includes('application submitted') ||
            body.includes('application sent') ||
            body.includes('your application was sent') ||
            body.includes('thank you') ||
            (await modal.count()) === 0;
          return {
            filledCount: matched.size,
            missingSelectors: answers.map((a) => a.fieldName).filter((name) => !matched.has(name)),
            submitted: successSignal,
            reason: successSignal
              ? 'LinkedIn Easy Apply submitted'
              : 'Submit clicked but no success signal detected',
          };
        } catch {
          return {
            filledCount: matched.size,
            missingSelectors: answers.map((a) => a.fieldName).filter((name) => !matched.has(name)),
            submitted: false,
            reason: 'Failed to click LinkedIn submit button',
          };
        }
      }

      const nextBtn = await this.findFirstEnabledButton(modal, [
        'button:has-text("Next")',
        'button:has-text("Review")',
        'button:has-text("Continue")',
        'button:has-text("Continue to next step")',
      ]);
      if (!nextBtn) {
        return {
          filledCount: matched.size,
          missingSelectors: answers.map((a) => a.fieldName).filter((name) => !matched.has(name)),
          submitted: false,
          reason:
            clickedSteps.length > 0
              ? 'LinkedIn Easy Apply flow ended before submit step'
              : 'LinkedIn Easy Apply step controls not found',
        };
      }

      const stepText = ((await nextBtn.innerText().catch(() => '')) || '').trim();
      clickedSteps.push(stepText || 'next');
      try {
        await nextBtn.click({ timeout: 5_000 });
        const moved = await this.waitForLinkedInModalTransition(page, modal, snapshotBefore, 2200);
        if (!moved) {
          // One retry after re-fill in case button was enabled but validation changed.
          await this.fillAnswersOnPage(page, answers);
          await nextBtn.click({ timeout: 4_000 });
          await this.waitForLinkedInModalTransition(page, modal, snapshotBefore, 2200);
        }
      } catch {
        return {
          filledCount: matched.size,
          missingSelectors: answers.map((a) => a.fieldName).filter((name) => !matched.has(name)),
          submitted: false,
          reason: 'Failed while navigating LinkedIn Easy Apply steps',
        };
      }
      await page.waitForTimeout(350);
    }

    return {
      filledCount: matched.size,
      missingSelectors: answers.map((a) => a.fieldName).filter((name) => !matched.has(name)),
      submitted: false,
      reason: 'Reached max LinkedIn Easy Apply steps without submit',
    };
  }

  private async findFirstEnabledButton(
    root: Locator,
    selectors: string[],
  ): Promise<Locator | null> {
    for (const selector of selectors) {
      const matches = root.locator(selector);
      const count = await matches.count().catch(() => 0);
      if (!count) continue;

      for (let i = 0; i < Math.min(count, 4); i += 1) {
        const btn = matches.nth(i);
        const visible = await btn.isVisible().catch(() => false);
        const disabled = await btn.isDisabled().catch(() => true);
        if (visible && !disabled) return btn;
      }
    }
    return null;
  }

  private async getLinkedInModalSnapshot(modal: Locator): Promise<string> {
    if (!(await modal.count().catch(() => 0))) return '';
    const text = (await modal.innerText().catch(() => ''))
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 600);
    return text;
  }

  private async waitForLinkedInModalTransition(
    page: Page,
    modal: Locator,
    before: string,
    timeoutMs: number,
  ): Promise<boolean> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      await page.waitForTimeout(140);
      const count = await modal.count().catch(() => 0);
      if (count === 0) return true;
      const now = await this.getLinkedInModalSnapshot(modal);
      if (now && before && now !== before) return true;
    }
    return false;
  }

  private async openLinkedInEasyApplyModal(page: Page): Promise<boolean> {
    const buttons = [
      'button:has-text("Easy Apply")',
      'button.jobs-apply-button',
      '[aria-label*="Easy Apply"]',
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

  private async openLinkedInExternalApply(page: Page): Promise<Page | null> {
    const context = page.context();
    const original = page.url();
    const buttons = [
      'a:has-text("Apply")',
      'button:has-text("Apply")',
      'a[aria-label*="Apply"]',
      'button[aria-label*="Apply"]',
    ];

    for (const selector of buttons) {
      const control = page.locator(selector).first();
      if (!(await control.count())) continue;

      try {
        const popupPromise = context.waitForEvent('page', { timeout: 4_000 }).catch(() => null);
        await control.click({ timeout: 5_000 });
        const popup = await popupPromise;
        if (popup) {
          await popup.waitForLoadState('domcontentloaded');
          const popupUrl = popup.url().toLowerCase();
          if (!popupUrl.includes('linkedin.com')) return popup;
          await popup.close().catch(() => undefined);
        }

        await page.waitForTimeout(1_500);
        const current = page.url().toLowerCase();
        if (!current.includes('linkedin.com') && current !== original.toLowerCase()) {
          return page;
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  private async prepareExternalApplyPage(page: Page): Promise<Page> {
    let activePage = page;
    for (let i = 0; i < 5; i += 1) {
      await activePage.waitForTimeout(600);
      await this.dismissCookieBanner(activePage);

      const intent = await this.detectPageIntent(activePage);
      this.log(`external intent=${intent} url=${activePage.url()}`);

      if (
        intent === 'application_form' ||
        intent === 'upload_resume_step' ||
        intent === 'review_submit_step'
      ) {
        return activePage;
      }

      const clicked = await this.clickExternalApplyCta(activePage);
      if (!clicked.clicked) {
        return activePage;
      }

      activePage = clicked.page;
      await activePage.waitForTimeout(1100);
    }
    return activePage;
  }

  private async dismissCookieBanner(page: Page): Promise<void> {
    const selectors = [
      'button:has-text("Okay")',
      'button:has-text("Accept")',
      'button:has-text("I Agree")',
      'button:has-text("Got it")',
      'button:has-text("Allow all")',
    ];

    for (const selector of selectors) {
      const btn = page.locator(selector).first();
      if (!(await btn.count())) continue;
      try {
        await btn.click({ timeout: 1500 });
        await page.waitForTimeout(300);
        return;
      } catch {
        // Ignore and continue.
      }
    }
  }

  private async clickExternalApplyCta(page: Page): Promise<{ clicked: boolean; page: Page }> {
    const ctas = [
      'button:has-text("Apply to this Job")',
      'a:has-text("Apply to this Job")',
      'button:has-text("Apply now")',
      'a:has-text("Apply now")',
      'button:has-text("Apply Now")',
      'a:has-text("Apply Now")',
      'button:has-text("Get Started")',
      'a:has-text("Get Started")',
      'button:has-text("Start Application")',
      'a:has-text("Start Application")',
      'button:has-text("Apply")',
      'a:has-text("Apply")',
    ];

    for (const selector of ctas) {
      const cta = page.locator(selector).first();
      if (!(await cta.count())) continue;
      try {
        const popupPromise = page
          .context()
          .waitForEvent('page', { timeout: 3000 })
          .catch(() => null);
        await cta.click({ timeout: 3000 });
        const popup = await popupPromise;
        if (popup) {
          await popup.waitForLoadState('domcontentloaded');
          return { clicked: true, page: popup };
        }
        return { clicked: true, page };
      } catch {
        // keep trying other selectors
      }
    }
    return { clicked: false, page };
  }

  private async trySubmit(
    page: Page,
    options: {
      captchaHandoff?: boolean;
      captchaHandoffTimeoutMs?: number;
      resumePath?: string;
    } = {},
  ): Promise<SubmitResult> {
    if (options.resumePath) {
      await this.ensureResumeAttachedBeforeSubmit(page, options.resumePath);
      const missing = await this.findMissingRequiredFileInputs(page);
      if (missing.length > 0) {
        return {
          submitted: false,
          reason: `Required resume/file input is empty before submit: ${missing.join(', ')}`,
        };
      }
    }

    const blocker = await this.detectHumanVerification(page);
    if (blocker.blocked) {
      const resumed = await this.waitForCaptchaHandoff(page, options);
      if (!resumed.resolved) {
        return {
          submitted: false,
          reason:
            resumed.reason ||
            blocker.reason ||
            'CAPTCHA or human verification required before submission',
        };
      }
      if (options.resumePath) {
        await this.ensureResumeAttachedBeforeSubmit(page, options.resumePath);
        const missing = await this.findMissingRequiredFileInputs(page);
        if (missing.length > 0) {
          return {
            submitted: false,
            reason: `Required resume/file input is empty after CAPTCHA verification: ${missing.join(', ')}`,
          };
        }
      }
    }

    const beforeUrl = page.url();
    const submitCandidates = [
      'button:has-text("Submit application")',
      'button:has-text("Submit Application")',
      'button:has-text("Submit")',
      'button[id*="submit"]',
      'button[data-qa*="submit"]',
      '#btn-submit',
      '.postings-btn.template-btn-submit',
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Review")',
      'button:has-text("Next")',
      'button:has-text("Continue")',
      'button:has-text("Apply")',
    ];
    let submitControlFound = false;
    let clickFailures = 0;

    for (const selector of submitCandidates) {
      const buttons = page.locator(selector);
      const count = await buttons.count().catch(() => 0);
      if (!count) continue;
      submitControlFound = true;

      const sample = Math.min(count, 4);
      for (let i = 0; i < sample; i += 1) {
        const button = buttons.nth(i);
        const visible = await button.isVisible().catch(() => false);
        if (!visible) continue;

        try {
          await button.scrollIntoViewIfNeeded().catch(() => undefined);
          const disabled = await button.isDisabled().catch(() => false);
          if (disabled) continue;
          await button.click({ timeout: 5_000 });
        } catch {
          clickFailures += 1;
          continue;
        }

        await page.waitForTimeout(2_000);
        const afterUrl = page.url();
        const body = (await page.textContent('body'))?.toLowerCase() || '';
        const successSignal =
          afterUrl !== beforeUrl ||
          body.includes('thank you') ||
          body.includes('application submitted') ||
          body.includes('we have received') ||
          body.includes('application sent');

        if (successSignal) {
          return { submitted: true, reason: 'Submission signal detected' };
        }

        const verificationError =
          body.includes('error verifying your application') ||
          body.includes('unable to verify your application') ||
          body.includes('verification failed');
        if (verificationError) {
          const resumed = await this.waitForCaptchaHandoff(page, options);
          if (resumed.resolved) {
            if (options.resumePath) {
              await this.ensureResumeAttachedBeforeSubmit(page, options.resumePath);
              const missing = await this.findMissingRequiredFileInputs(page);
              if (missing.length > 0) {
                return {
                  submitted: false,
                  reason: `Required resume/file input is empty after verification retry: ${missing.join(', ')}`,
                };
              }
            }
            continue;
          }
          return {
            submitted: false,
            reason:
              resumed.reason ||
              'Application verification failed. Complete CAPTCHA/hCaptcha challenge and retry submit.',
          };
        }

        const hasHCaptcha =
          (await page
            .locator('#h-captcha, .h-captcha, [data-sitekey]')
            .count()
            .catch(() => 0)) > 0;
        const hasValidation =
          body.includes('required') ||
          body.includes('this field is required') ||
          body.includes('please fill out') ||
          body.includes('invalid');
        if (hasHCaptcha) {
          const resumed = await this.waitForCaptchaHandoff(page, options);
          if (resumed.resolved) {
            if (options.resumePath) {
              await this.ensureResumeAttachedBeforeSubmit(page, options.resumePath);
              const missing = await this.findMissingRequiredFileInputs(page);
              if (missing.length > 0) {
                return {
                  submitted: false,
                  reason: `Required resume/file input is empty after CAPTCHA challenge: ${missing.join(', ')}`,
                };
              }
            }
            continue;
          }
          return {
            submitted: false,
            reason:
              resumed.reason ||
              'Submit clicked but hCaptcha/manual verification is blocking completion',
          };
        }
        if (hasValidation) {
          return {
            submitted: false,
            reason: 'Submit clicked but form validation errors are still present',
          };
        }
      }
    }

    if (submitControlFound) {
      return {
        submitted: false,
        reason:
          clickFailures > 0
            ? 'Submit control detected but click failed or was blocked by page state'
            : 'Submit control detected but submission not confirmed',
      };
    }

    return { submitted: false, reason: 'No submit control detected on page' };
  }

  private async tryExternalSubmit(
    page: Page,
    options: {
      captchaHandoff?: boolean;
      captchaHandoffTimeoutMs?: number;
      resumePath?: string;
    } = {},
  ): Promise<SubmitResult> {
    await this.waitForResumeProcessing(page);
    if (options.resumePath) {
      await this.ensureResumeAttachedBeforeSubmit(page, options.resumePath);
    }

    const modalResult = await this.trySubmitInModalSteps(page);
    if (modalResult.submitted) return modalResult;

    const direct = await this.trySubmit(page, options);
    if (direct.submitted) return direct;
    if (direct.reason && direct.reason !== 'No submit control detected on page') {
      return { submitted: false, reason: direct.reason };
    }
    if (modalResult.reason && modalResult.reason !== 'No modal submit controls detected') {
      return { submitted: false, reason: modalResult.reason };
    }
    return {
      submitted: false,
      reason: direct.reason || modalResult.reason || 'No submit control detected on page',
    };
  }

  private async waitForResumeProcessing(page: Page): Promise<void> {
    const maxWaitMs = 35_000;
    const started = Date.now();

    while (Date.now() - started < maxWaitMs) {
      const body = ((await page.textContent('body').catch(() => '')) || '').toLowerCase();
      const stillProcessing =
        body.includes('reading your resume') ||
        body.includes('upload your resume to apply') ||
        body.includes('processing');
      if (!stillProcessing) return;
      await page.waitForTimeout(900);
    }
  }

  private async trySubmitInModalSteps(page: Page): Promise<SubmitResult> {
    const maxSteps = 8;
    const modal = page.locator('[role="dialog"]').last();
    if (!(await modal.count())) {
      return { submitted: false, reason: 'No modal submit controls detected' };
    }

    for (let i = 0; i < maxSteps; i += 1) {
      const submitBtn = modal
        .locator(
          'button:has-text("Submit"), button:has-text("Apply"), button:has-text("Apply Now"), button:has-text("Finish")',
        )
        .first();
      if ((await submitBtn.count()) > 0) {
        try {
          await submitBtn.click({ timeout: 4_000 });
        } catch {
          return {
            submitted: false,
            reason: 'Failed clicking modal submit/apply button',
          };
        }
        await page.waitForTimeout(2_000);
        const body = ((await page.textContent('body').catch(() => '')) || '').toLowerCase();
        if (
          body.includes('application submitted') ||
          body.includes('applied successfully') ||
          body.includes('thank you') ||
          body.includes('application sent')
        ) {
          return { submitted: true, reason: 'External modal submit confirmed' };
        }
      }

      const nextBtn = modal
        .locator(
          'button:has-text("Continue"), button:has-text("Next"), button:has-text("Review"), button:has-text("Proceed")',
        )
        .first();
      if ((await nextBtn.count()) === 0) {
        break;
      }

      try {
        await nextBtn.click({ timeout: 4_000 });
      } catch {
        return {
          submitted: false,
          reason: 'Failed navigating external modal steps',
        };
      }
      await page.waitForTimeout(1_200);
      await this.waitForResumeProcessing(page);
    }

    return { submitted: false, reason: 'No modal submit controls detected' };
  }

  private async capturePreview(page: Page, label: string): Promise<string> {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.resolve(process.cwd(), '.preview');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${label}-${ts}.png`);
    await page.screenshot({ path: file, fullPage: true });
    return file;
  }

  private resolveResumeFilePath(useSecondary: boolean): string {
    const candidates: string[] = [];
    if (useSecondary) {
      const profileSecondary = this.loadSecondaryIdentityData();
      if (profileSecondary.resumeFilePath) candidates.push(profileSecondary.resumeFilePath);
      candidates.push(env.SECONDARY_RESUME_FILE_PATH);
    } else {
      const profilePrimary = this.loadPrimaryIdentityData();
      if (profilePrimary.resumeFilePath) candidates.push(profilePrimary.resumeFilePath);
      candidates.push(env.RESUME_FILE_PATH);
    }

    for (const candidate of candidates) {
      const resolved = path.isAbsolute(candidate)
        ? candidate
        : path.resolve(process.cwd(), candidate);
      if (fs.existsSync(resolved)) return resolved;
    }

    const fallback = useSecondary ? env.SECONDARY_RESUME_FILE_PATH : env.RESUME_FILE_PATH;
    return path.isAbsolute(fallback) ? fallback : path.resolve(process.cwd(), fallback);
  }

  private async attachResumeToInput(target: Locator, resumePath: string): Promise<boolean> {
    if (!fs.existsSync(resumePath)) return false;
    try {
      await target.setInputFiles(resumePath);
      const hasFile = await target
        .evaluate((el) => {
          const input = el as HTMLInputElement;
          return Boolean(input.files && input.files.length > 0);
        })
        .catch(() => false);
      return hasFile;
    } catch {
      return false;
    }
  }

  private async autoAttachResumeIfAny(page: Page, resumePath: string): Promise<number> {
    if (!fs.existsSync(resumePath)) {
      this.log(`resume attach skipped; file_not_found path=${resumePath}`);
      return 0;
    }

    const fileInputs = page.locator('input[type="file"]');
    const count = await fileInputs.count();
    if (!count) {
      this.log('resume attach skipped; no file inputs found');
      return 0;
    }

    const scored: Array<{ index: number; score: number }> = [];
    for (let i = 0; i < count; i += 1) {
      const input = fileInputs.nth(i);
      const meta = await input
        .evaluate((el) => {
          const node = el as HTMLInputElement;
          const key =
            `${node.name || ''} ${node.id || ''} ${node.getAttribute('aria-label') || ''}`.toLowerCase();
          return {
            required: Boolean(node.required),
            key,
          };
        })
        .catch(() => ({ required: false, key: '' }));
      let score = 0;
      if (meta.required) score += 50;
      if (meta.key.includes('resume') || meta.key.includes('cv')) score += 40;
      if (meta.key.includes('attach') || meta.key.includes('upload')) score += 20;
      scored.push({ index: i, score });
    }

    scored.sort((a, b) => b.score - a.score);

    let attached = 0;
    for (const candidate of scored) {
      const input = fileInputs.nth(candidate.index);
      const ok = await this.attachResumeToInput(input, resumePath);
      if (ok) attached += 1;
    }

    if (attached === 0) {
      // One extra retry in case form re-rendered.
      await page.waitForTimeout(500);
      const retryInputs = page.locator('input[type="file"]');
      const retryCount = await retryInputs.count().catch(() => 0);
      for (let i = 0; i < retryCount; i += 1) {
        const ok = await this.attachResumeToInput(retryInputs.nth(i), resumePath);
        if (ok) attached += 1;
      }
    }

    this.log(`resume attach attempted inputs=${count} attached=${attached} path=${resumePath}`);
    return attached;
  }

  private async findMissingRequiredFileInputs(page: Page): Promise<string[]> {
    const fileInputs = page.locator('input[type="file"]');
    const count = await fileInputs.count().catch(() => 0);
    if (!count) return [];

    const missing: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const input = fileInputs.nth(i);
      const meta = await input
        .evaluate((el) => {
          const node = el as HTMLInputElement;
          return {
            required: Boolean(node.required),
            name: node.name || node.id || 'file',
            hasFile: Boolean(node.files && node.files.length > 0),
          };
        })
        .catch(() => null);
      if (!meta) continue;
      if (meta.required && !meta.hasFile) {
        missing.push(meta.name);
      }
    }
    return missing;
  }

  private async resolveIdentityContext(page: Page): Promise<IdentityContext> {
    const googleAuth = await this.isGoogleAuthContext(page);
    if (googleAuth) {
      const secondary = this.loadSecondaryIdentityData();
      return {
        useSecondary: true,
        email: secondary.email || env.SECONDARY_EMAIL,
        resumePath: this.resolveResumeFilePath(true),
        name: secondary.name,
        linkedin: secondary.linkedin,
        github: secondary.github,
        phone: secondary.phone,
      };
    }

    return {
      useSecondary: false,
      email: this.loadPrimaryContactData().email || '',
      resumePath: this.resolveResumeFilePath(false),
      phone: this.loadPrimaryContactData().phone || '',
    };
  }

  private loadSecondaryIdentityData(): {
    name?: string;
    email?: string;
    phone?: string;
    linkedin?: string;
    github?: string;
    resumeFilePath?: string;
  } {
    const configured = env.SECONDARY_CANDIDATE_PROFILE_PATH;
    const filePath = path.isAbsolute(configured)
      ? configured
      : path.resolve(process.cwd(), configured);
    if (!fs.existsSync(filePath)) return {};

    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as {
        name?: string;
        email?: string;
        phone?: string;
        linkedin?: string;
        github?: string;
        resumeFilePath?: string;
      };
      return parsed;
    } catch {
      return {};
    }
  }

  private loadPrimaryIdentityData(): {
    resumeFilePath?: string;
    skills?: string[];
    skillYears?: Record<string, number>;
  } {
    const configured = env.CANDIDATE_PROFILE_PATH;
    const filePath = path.isAbsolute(configured)
      ? configured
      : path.resolve(process.cwd(), configured);
    const fromCandidate: {
      resumeFilePath?: string;
      skills?: string[];
      skillYears?: Record<string, number>;
    } = {};
    const fromManual: {
      skills?: string[];
      skillYears?: Record<string, number>;
    } = {};

    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw) as {
          resumeFilePath?: string;
          skills?: string[];
        };
        fromCandidate.resumeFilePath = parsed.resumeFilePath;
        fromCandidate.skills = parsed.skills || [];
      } catch {
        // ignore
      }
    }

    const manualPath = path.isAbsolute(env.MANUAL_PROFILE_PATH)
      ? env.MANUAL_PROFILE_PATH
      : path.resolve(process.cwd(), env.MANUAL_PROFILE_PATH);
    if (fs.existsSync(manualPath)) {
      try {
        const raw = fs.readFileSync(manualPath, 'utf8');
        const parsed = JSON.parse(raw) as {
          preferences?: { skillYears?: Record<string, number> };
        };
        fromManual.skillYears = parsed.preferences?.skillYears || {};
      } catch {
        // ignore
      }
    }

    return {
      resumeFilePath: fromCandidate.resumeFilePath,
      skills: fromCandidate.skills || [],
      skillYears: fromManual.skillYears || {},
    };
  }

  private loadPrimaryContactData(): {
    email?: string;
    phone?: string;
  } {
    const output: { email?: string; phone?: string } = {};

    const candidatePath = path.isAbsolute(env.CANDIDATE_PROFILE_PATH)
      ? env.CANDIDATE_PROFILE_PATH
      : path.resolve(process.cwd(), env.CANDIDATE_PROFILE_PATH);
    if (fs.existsSync(candidatePath)) {
      try {
        const raw = fs.readFileSync(candidatePath, 'utf8');
        const parsed = JSON.parse(raw) as { email?: string; phone?: string };
        output.email = parsed.email || output.email;
        output.phone = parsed.phone || output.phone;
      } catch {
        // ignore
      }
    }

    const manualPath = path.isAbsolute(env.MANUAL_PROFILE_PATH)
      ? env.MANUAL_PROFILE_PATH
      : path.resolve(process.cwd(), env.MANUAL_PROFILE_PATH);
    if (fs.existsSync(manualPath)) {
      try {
        const raw = fs.readFileSync(manualPath, 'utf8');
        const parsed = JSON.parse(raw) as {
          emails?: string[];
          phones?: string[];
        };
        output.email = parsed.emails?.[0] || output.email;
        output.phone = parsed.phones?.[0] || output.phone;
      } catch {
        // ignore
      }
    }

    return output;
  }

  private inferYearsForSkill(skillRaw: string): number {
    const skill = this.normalizeSkillKey(skillRaw);
    if (!skill) return 0;

    const primary = this.loadPrimaryIdentityData();
    const explicit = primary.skillYears || {};
    for (const [k, v] of Object.entries(explicit)) {
      if (this.normalizeSkillKey(k) === skill) return Math.max(0, Math.floor(v));
    }

    const knownSkills = new Set<string>(
      (primary.skills || []).map((s) => this.normalizeSkillKey(s)),
    );
    return knownSkills.has(skill) ? 1 : 0;
  }

  private normalizeSkillKey(input: string): string {
    return (input || '')
      .toLowerCase()
      .replace(/[\(\)\[\],]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace('react js', 'react')
      .replace('react.js', 'react')
      .replace('vue js', 'vue')
      .replace('vue.js', 'vue')
      .replace('node js', 'node.js')
      .replace('nodejs', 'node.js')
      .replace('express js', 'express.js')
      .replace('next js', 'next.js');
  }

  private extractSkillFromYearsQuestion(context: string): string {
    const m = context.match(/with\s+([a-z0-9.+#/\-\s]+)\??/i);
    return m?.[1]?.trim() || '';
  }

  private async isGoogleAuthContext(page: Page): Promise<boolean> {
    const url = page.url().toLowerCase();
    if (url.includes('accounts.google.com')) return true;

    const googleControls = [
      'button:has-text("Continue with Google")',
      'a:has-text("Continue with Google")',
      'button:has-text("Sign in with Google")',
      'a:has-text("Sign in with Google")',
      '[href*="accounts.google.com"]',
    ];
    for (const selector of googleControls) {
      if ((await page.locator(selector).count()) > 0) return true;
    }

    const body = ((await page.textContent('body').catch(() => '')) || '').toLowerCase();
    return body.includes('continue with google') || body.includes('sign in with google');
  }

  private async hasApplicationSurface(page: Page): Promise<boolean> {
    const formFields = await page.locator('input, textarea, select').count();
    if (formFields > 0) return true;

    if (await this.isGoogleAuthContext(page)) return true;

    const body = ((await page.textContent('body').catch(() => '')) || '').toLowerCase();
    return (
      body.includes('upload your resume') ||
      body.includes('apply now') ||
      body.includes('application form')
    );
  }

  private async detectPageIntent(
    page: Page,
  ): Promise<
    'landing' | 'auth' | 'application_form' | 'upload_resume_step' | 'review_submit_step'
  > {
    const body = ((await page.textContent('body').catch(() => '')) || '').toLowerCase();
    const controls = (
      await page
        .locator("button, a, input[type='submit']")
        .allInnerTexts()
        .catch(() => [])
    )
      .join(' ')
      .toLowerCase();
    const hasFormFields = (await page.locator('input, textarea, select').count()) > 0;

    if (await this.isGoogleAuthContext(page)) return 'auth';
    if (body.includes('upload your resume') || body.includes('reading your resume'))
      return 'upload_resume_step';
    if (
      controls.includes('review') ||
      controls.includes('submit') ||
      controls.includes('finish') ||
      controls.includes('complete application')
    ) {
      return 'review_submit_step';
    }
    if (hasFormFields) return 'application_form';
    return 'landing';
  }

  private resolveContextOptions(url: string, options: PageRunOptions): BrowserContextOptions {
    const mode = options.authMode ?? 'auto';
    const includeLinkedIn = options.useLinkedInAuth && this.isLinkedIn(url) && mode !== 'google';
    const includeGoogle =
      options.useGoogleAuth &&
      mode !== 'linkedin' &&
      (mode === 'google' || this.shouldUseGoogleAuthForUrl(url));

    const states: Array<{
      cookies: unknown[];
      origins: Array<{ origin: string; localStorage: unknown[] }>;
    }> = [];

    if (includeLinkedIn && this.shouldUseLinkedInAuth()) {
      const linkedInState = this.readStorageStateFile(this.linkedinStorageStatePath());
      if (linkedInState) states.push(linkedInState);
    }

    if (includeGoogle && this.hasGoogleAuthState()) {
      const googleState = this.readStorageStateFile(this.googleStorageStatePath());
      if (googleState) states.push(googleState);
    }

    if (states.length === 0) return {};
    if (states.length === 1)
      return {
        storageState: states[0] as BrowserContextOptions['storageState'],
      };
    return {
      storageState: this.mergeStorageStates(states) as BrowserContextOptions['storageState'],
    };
  }

  private shouldUseLinkedInAuth(): boolean {
    return env.LINKEDIN_AUTH_ENABLED && this.hasLinkedInAuthState();
  }

  private shouldUseGoogleAuthForUrl(url: string): boolean {
    if (!env.GOOGLE_AUTH_ENABLED) return false;
    const allowlist = (env.GOOGLE_AUTH_DOMAIN_ALLOWLIST || '')
      .split(',')
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);
    if (allowlist.length === 0) return true;

    const lower = url.toLowerCase();
    return allowlist.some((domain) => lower.includes(domain));
  }

  private linkedinStorageStatePath(): string {
    const configured = env.LINKEDIN_STORAGE_STATE_PATH;
    return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
  }

  private googleStorageStatePath(): string {
    const configured = env.GOOGLE_STORAGE_STATE_PATH;
    return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
  }

  private readStorageStateFile(filePath: string): {
    cookies: unknown[];
    origins: Array<{ origin: string; localStorage: unknown[] }>;
  } | null {
    if (!fs.existsSync(filePath)) return null;
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(raw) as {
        cookies: unknown[];
        origins: Array<{ origin: string; localStorage: unknown[] }>;
      };
    } catch {
      return null;
    }
  }

  private mergeStorageStates(
    states: Array<{
      cookies: unknown[];
      origins: Array<{ origin: string; localStorage: unknown[] }>;
    }>,
  ): {
    cookies: unknown[];
    origins: Array<{ origin: string; localStorage: unknown[] }>;
  } {
    const cookies: unknown[] = [];
    const cookieKeys = new Set<string>();
    const origins = new Map<string, { origin: string; localStorage: unknown[] }>();

    for (const state of states) {
      for (const c of state.cookies || []) {
        const cookie = c as { name?: string; domain?: string; path?: string };
        const key = `${cookie.name || ''}|${cookie.domain || ''}|${cookie.path || ''}`;
        if (cookieKeys.has(key)) continue;
        cookieKeys.add(key);
        cookies.push(c);
      }

      for (const origin of state.origins || []) {
        if (!origin?.origin) continue;
        origins.set(origin.origin, origin);
      }
    }

    return { cookies, origins: Array.from(origins.values()) };
  }

  private isLinkedIn(url: string): boolean {
    return url.toLowerCase().includes('linkedin.com');
  }

  private looksGoogleRelatedUrl(url: string): boolean {
    const lower = url.toLowerCase();
    return lower.includes('google') || lower.includes('accounts.');
  }

  private escapeForAttributeSelector(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  private toBooleanAnswer(value: string, defaultValue: boolean): boolean {
    const normalized = (value || '').trim().toLowerCase();
    if (!normalized) return defaultValue;
    if (['true', 'yes', 'y', '1', 'on', 'agree'].includes(normalized)) return true;
    if (['false', 'no', 'n', '0', 'off', 'disagree'].includes(normalized)) return false;
    return defaultValue;
  }

  private escapeForTextSelector(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  private async findTargetInput(
    page: Page,
    modal: Locator | null,
    fieldName: string,
  ): Promise<Locator | null> {
    const escaped = this.escapeForAttributeSelector(fieldName);
    const escapedText = this.escapeForTextSelector(fieldName);
    const selectorByIdentity = `[name="${escaped}"], [id="${escaped}"]`;
    const selectorByHint = [
      `[aria-label="${escaped}"]`,
      `[placeholder="${escaped}"]`,
      `label:has-text("${escapedText}") + input`,
      `label:has-text("${escapedText}") + textarea`,
      `label:has-text("${escapedText}") + select`,
    ].join(', ');

    if (modal) {
      const fromModalIdentity = await this.findActionableField(modal.locator(selectorByIdentity));
      if (fromModalIdentity) return fromModalIdentity;
      const fromModalHint = await this.findActionableField(modal.locator(selectorByHint));
      if (fromModalHint) return fromModalHint;
    }

    const fromPageIdentity = await this.findActionableField(page.locator(selectorByIdentity));
    if (fromPageIdentity) return fromPageIdentity;
    const fromPageHint = await this.findActionableField(page.locator(selectorByHint));
    if (fromPageHint) return fromPageHint;

    return null;
  }

  private async findActionableField(candidates: Locator): Promise<Locator | null> {
    const count = await candidates.count();
    if (!count) return null;

    let firstNonHidden: Locator | null = null;

    for (let i = 0; i < count; i += 1) {
      const candidate = candidates.nth(i);
      const meta = await candidate
        .evaluate((el) => {
          const input = el as HTMLInputElement;
          const computed = window.getComputedStyle(el);
          return {
            type: (input.type || '').toLowerCase(),
            disabled: Boolean(input.disabled),
            hiddenAttr: el.hasAttribute('hidden'),
            ariaHidden: (el.getAttribute('aria-hidden') || '').toLowerCase() === 'true',
            display: computed.display,
            visibility: computed.visibility,
          };
        })
        .catch(() => null);

      if (!meta) continue;
      if (meta.type === 'hidden') continue;
      if (meta.disabled) continue;

      if (!firstNonHidden) firstNonHidden = candidate;

      const visible = await candidate.isVisible().catch(() => false);
      const styledInvisible =
        meta.hiddenAttr ||
        meta.ariaHidden ||
        meta.display === 'none' ||
        meta.visibility === 'hidden';
      if (visible && !styledInvisible) return candidate;
    }

    return firstNonHidden;
  }

  private async toggleCheckboxWithFallback(
    page: Page,
    checkbox: Locator,
    shouldCheck: boolean,
  ): Promise<boolean> {
    try {
      if (shouldCheck) {
        await checkbox.check();
      } else {
        await checkbox.uncheck().catch(() => undefined);
      }
      const checked = await checkbox.isChecked().catch(() => false);
      if (checked === shouldCheck) return true;
    } catch {
      // Fallback below.
    }

    const targetRef = await checkbox
      .evaluate((el) => {
        const input = el as HTMLInputElement;
        return {
          id: input.id || '',
          name: input.name || '',
        };
      })
      .catch(() => ({ id: '', name: '' }));

    if (targetRef.id) {
      const label = page
        .locator(`label[for="${this.escapeForAttributeSelector(targetRef.id)}"]`)
        .first();
      if ((await label.count().catch(() => 0)) > 0) {
        try {
          await label.click({ timeout: 2_000 });
          const checked = await checkbox.isChecked().catch(() => false);
          if (checked === shouldCheck) return true;
        } catch {
          // continue
        }
      }
    }

    if (shouldCheck) {
      try {
        await checkbox.click({ force: true, timeout: 2_000 });
        const checked = await checkbox.isChecked().catch(() => false);
        return checked === true;
      } catch {
        return false;
      }
    }

    return false;
  }

  private async extractFieldContextText(page: Page, target: Locator): Promise<string> {
    const context = await target
      .evaluate((el) => {
        const node = el as HTMLInputElement;
        const id = node.id || '';
        const associatedLabel = id ? document.querySelector(`label[for="${id}"]`) : null;
        const parentLabel = node.closest('label');
        const questionContainer =
          node.closest('fieldset') ||
          node.closest('.application-question') ||
          node.closest('.application-field') ||
          node.closest('.card-field') ||
          node.parentElement;
        const questionText = (questionContainer?.textContent || '').slice(0, 300);
        return [
          node.name || '',
          node.id || '',
          node.getAttribute('aria-label') || '',
          node.placeholder || '',
          associatedLabel?.textContent || '',
          parentLabel?.textContent || '',
          questionText,
        ]
          .join(' ')
          .toLowerCase();
      })
      .catch(() => '');
    return context || (await page.title().catch(() => ''));
  }

  private async trySelectBinaryCheckboxOption(
    page: Page,
    modal: Locator | null,
    target: Locator,
    desiredValue: string,
  ): Promise<boolean | null> {
    const normalized = (desiredValue || '').trim().toLowerCase();
    const wantsNo =
      normalized.includes('no') || ['false', '0', 'n', 'disagree'].includes(normalized);
    const wantsYes = normalized.includes('yes') || ['true', '1', 'y', 'agree'].includes(normalized);
    if (!wantsNo && !wantsYes) return null;

    const targetMeta = await target
      .evaluate((el) => {
        const node = el as HTMLInputElement;
        return { name: node.name || '', id: node.id || '' };
      })
      .catch(() => ({ name: '', id: '' }));

    const root = modal && (await modal.count()) > 0 ? modal : page.locator('body');
    const escapedName = this.escapeForAttributeSelector(targetMeta.name || '');
    const group = targetMeta.name
      ? root.locator(`input[type="checkbox"][name="${escapedName}"]`)
      : root.locator("input[type='checkbox']");

    const count = await group.count().catch(() => 0);
    if (!count) return null;

    let fallback: Locator | null = null;
    for (let i = 0; i < Math.min(count, 8); i += 1) {
      const checkbox = group.nth(i);
      const visible = await checkbox.isVisible().catch(() => false);
      if (!visible) continue;
      if (!fallback) fallback = checkbox;

      const meta = await checkbox
        .evaluate((el) => {
          const node = el as HTMLInputElement;
          const id = node.id || '';
          const associatedLabel = id ? document.querySelector(`label[for="${id}"]`) : null;
          const siblingLabel =
            (el.nextElementSibling && el.nextElementSibling.tagName.toLowerCase() === 'label'
              ? el.nextElementSibling
              : null) ||
            (el.parentElement?.tagName.toLowerCase() === 'label' ? el.parentElement : null);
          const container = node.closest('fieldset') || node.parentElement;
          return {
            value: (node.value || '').toLowerCase(),
            aria: (node.getAttribute('aria-label') || '').toLowerCase(),
            label: (
              (associatedLabel?.textContent || siblingLabel?.textContent || '') as string
            ).toLowerCase(),
            container: ((container?.textContent || '') as string).toLowerCase().slice(0, 220),
          };
        })
        .catch(() => null);
      if (!meta) continue;

      const haystack = `${meta.value} ${meta.aria} ${meta.label} ${meta.container}`;
      const matchNo =
        /\bno\b/.test(haystack) || /\bfalse\b/.test(haystack) || /\bnone\b/.test(haystack);
      const matchYes = /\byes\b/.test(haystack) || /\btrue\b/.test(haystack);
      const shouldPick = (wantsNo && matchNo) || (wantsYes && matchYes);
      if (!shouldPick) continue;

      return this.toggleCheckboxWithFallback(page, checkbox, true);
    }

    if (fallback && wantsYes) {
      return this.toggleCheckboxWithFallback(page, fallback, true);
    }
    return wantsNo ? false : null;
  }

  private async ensureResumeAttachedBeforeSubmit(page: Page, resumePath: string): Promise<void> {
    const missingBefore = await this.findMissingRequiredFileInputs(page);
    if (!missingBefore.length) return;
    this.log(`required file input missing before submit: ${missingBefore.join(', ')}`);
    await this.autoAttachResumeIfAny(page, resumePath);
    const missingAfter = await this.findMissingRequiredFileInputs(page);
    if (missingAfter.length) {
      this.log(`required file input still missing after reattach: ${missingAfter.join(', ')}`);
    } else {
      this.log('required file input restored before submit');
    }
  }

  private async selectRadioOption(
    page: Page,
    modal: Locator,
    target: Locator,
    fieldName: string,
    desiredValue: string,
  ): Promise<boolean> {
    const normalizedDesired = (desiredValue || '').trim().toLowerCase();
    const nameAttr = await target.getAttribute('name').catch(() => null);
    const root = (await modal.count()) > 0 ? modal : page.locator('body');

    const escapedField = this.escapeForAttributeSelector(fieldName);
    const escapedName = nameAttr ? this.escapeForAttributeSelector(nameAttr) : '';

    const group = nameAttr
      ? root.locator(`input[type="radio"][name="${escapedName}"]`)
      : root.locator(
          `input[type="radio"][name="${escapedField}"], input[type="radio"][id="${escapedField}"]`,
        );

    const count = await group.count().catch(() => 0);
    if (!count) {
      try {
        await target.check();
        return true;
      } catch {
        return false;
      }
    }

    let fallbackFirstVisible: Locator | null = null;
    for (let i = 0; i < count; i += 1) {
      const radio = group.nth(i);
      const visible = await radio.isVisible().catch(() => false);
      if (!visible) continue;
      if (!fallbackFirstVisible) fallbackFirstVisible = radio;

      const meta = await radio
        .evaluate((el) => {
          const input = el as HTMLInputElement;
          const id = input.id || '';
          const associatedLabel = id ? document.querySelector(`label[for="${id}"]`) : null;
          const siblingLabel =
            (el.nextElementSibling && el.nextElementSibling.tagName.toLowerCase() === 'label'
              ? el.nextElementSibling
              : null) ||
            (el.parentElement?.tagName.toLowerCase() === 'label' ? el.parentElement : null);

          return {
            value: (input.value || '').toLowerCase(),
            ariaLabel: ((input.getAttribute('aria-label') || '') as string).toLowerCase(),
            id: id.toLowerCase(),
            name: (input.name || '').toLowerCase(),
            labelText: (
              (associatedLabel?.textContent || siblingLabel?.textContent || '') as string
            ).toLowerCase(),
          };
        })
        .catch(() => null);

      if (!meta) continue;
      const haystack = `${meta.value} ${meta.ariaLabel} ${meta.id} ${meta.name} ${meta.labelText}`;
      const wantsNo =
        normalizedDesired.includes('no') ||
        ['false', '0', 'n', 'disagree'].includes(normalizedDesired);
      const wantsYes =
        normalizedDesired.includes('yes') ||
        ['true', '1', 'y', 'agree'].includes(normalizedDesired);
      const shouldPick =
        (wantsNo &&
          (/\bno\b/.test(haystack) || /\bfalse\b/.test(haystack) || /\b0\b/.test(haystack))) ||
        (wantsYes &&
          (/\byes\b/.test(haystack) || /\btrue\b/.test(haystack) || /\b1\b/.test(haystack))) ||
        (normalizedDesired && haystack.includes(normalizedDesired));

      if (shouldPick) {
        try {
          await radio.check();
          return true;
        } catch {
          return false;
        }
      }
    }

    if (fallbackFirstVisible) {
      try {
        if (normalizedDesired.includes('no')) {
          return false;
        }
        await fallbackFirstVisible.check();
        return true;
      } catch {
        return false;
      }
    }

    return false;
  }

  private shouldDefaultCheckboxToTrue(fieldName: string): boolean {
    const f = (fieldName || '').toLowerCase();
    if (
      f.includes('non-compete') ||
      f.includes('non compete') ||
      f.includes('prevent you from working')
    ) {
      return false;
    }
    return (
      f.includes('agree') ||
      f.includes('consent') ||
      f.includes('terms') ||
      f.includes('privacy') ||
      f.includes('policy') ||
      f.includes('gdpr') ||
      f.includes('authorize') ||
      f.includes('store')
    );
  }

  private async detectHumanVerification(
    page: Page,
  ): Promise<{ blocked: boolean; reason?: string }> {
    const body = ((await page.textContent('body').catch(() => '')) || '').toLowerCase();
    const strongTextHints = [
      'verify you are human',
      'security verification',
      'please complete the captcha',
      "i'm not a robot",
      'checking your browser before accessing',
      'cf-challenge',
    ];
    const textBlocked = strongTextHints.some((h) => body.includes(h));
    if (textBlocked) {
      return {
        blocked: true,
        reason: 'CAPTCHA/human verification detected on page',
      };
    }

    const selectors = [
      'iframe[src*="recaptcha"]',
      'iframe[title*="reCAPTCHA"]',
      '.g-recaptcha',
      'iframe[src*="hcaptcha"]',
      '.h-captcha',
      '[data-sitekey]',
      '[id*="captcha"]',
      '[class*="captcha"]',
      'input[name*="captcha"]',
    ];
    for (const selector of selectors) {
      const nodes = page.locator(selector);
      const count = await nodes.count().catch(() => 0);
      const sample = Math.min(count, 3);
      let hasVisible = false;
      for (let i = 0; i < sample; i += 1) {
        if (
          await nodes
            .nth(i)
            .isVisible()
            .catch(() => false)
        ) {
          hasVisible = true;
          break;
        }
      }

      if (hasVisible) {
        return { blocked: true, reason: 'CAPTCHA widget detected on page' };
      }
    }

    return { blocked: false };
  }

  private async waitForCaptchaHandoff(
    page: Page,
    options: { captchaHandoff?: boolean; captchaHandoffTimeoutMs?: number },
  ): Promise<{ resolved: boolean; reason?: string }> {
    if (!options.captchaHandoff) {
      return { resolved: false };
    }

    const timeoutMs = Math.max(10_000, options.captchaHandoffTimeoutMs ?? 180_000);
    const started = Date.now();
    this.log(`captcha handoff waiting timeoutMs=${timeoutMs} url=${page.url()}`);

    while (Date.now() - started < timeoutMs) {
      await page.waitForTimeout(1200);
      const blocker = await this.detectHumanVerification(page);
      if (!blocker.blocked) {
        this.log(`captcha handoff resolved url=${page.url()}`);
        return { resolved: true };
      }
    }

    const seconds = Math.round(timeoutMs / 1000);
    this.log(`captcha handoff timed_out after=${seconds}s url=${page.url()}`);
    return {
      resolved: false,
      reason: `CAPTCHA still present after waiting ${seconds}s for manual verification`,
    };
  }

  private overrideAnswerByContext(context: string, currentValue: string): string {
    const c = (context || '').toLowerCase();
    if (
      c.includes('have you completed the following level of education') ||
      c.includes("bachelor's degree") ||
      c.includes('bachelors degree') ||
      c.includes('b.tech') ||
      c.includes('btech')
    ) {
      return 'Yes';
    }
    if (c.includes('official notice period') || c.includes('notice period')) {
      return '0';
    }
    if (c.includes('last working day') || c.includes('lwd')) {
      return 'N/A';
    }
    if (
      c.includes('non-compete') ||
      c.includes('non compete') ||
      c.includes('prevent you from working')
    ) {
      return 'No';
    }
    if (
      c.includes('base salary expectation') ||
      c.includes('base salary expectations') ||
      c.includes('salary expectation') ||
      c.includes('salary expectations') ||
      c.includes('expected salary') ||
      c.includes('expected ctc') ||
      c.includes('compensation expectation')
    ) {
      return '20 LPA';
    }
    if (
      c.includes('current salary') ||
      c.includes('present salary') ||
      c.includes('current ctc') ||
      c.includes('existing salary')
    ) {
      return 'N/A';
    }

    if (c.includes('how many years of work experience do you have with')) {
      const skill = this.extractSkillFromYearsQuestion(c);
      const years = this.inferYearsForSkill(skill);
      return String(years);
    }
    return currentValue;
  }

  private async readInputValue(target: Locator): Promise<string> {
    return target.evaluate((el) => ((el as HTMLInputElement).value || '').trim()).catch(() => '');
  }

  private looksValidEmail(value: string): boolean {
    const v = (value || '').trim();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
  }

  private looksValidPhone(value: string): boolean {
    const digits = (value || '').replace(/\D/g, '');
    return digits.length >= 10 && digits.length <= 15;
  }

  private isSuspiciousPhone(value: string): boolean {
    const digits = (value || '').replace(/\D/g, '');
    return /^(\d)\1{6,}$/.test(digits);
  }

  private log(message: string): void {
    console.log(`[browser-tool] ${message}`);
  }
}
