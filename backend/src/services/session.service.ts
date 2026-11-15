import crypto from 'node:crypto';
import fs from 'node:fs';
import { Browser, BrowserContext, BrowserContextOptions, chromium } from 'playwright';
import { z } from 'zod';
import { browserInteractiveEnabled, env } from '../config/env';
import { paths, SessionProvider } from '../config/paths';
import { HttpError } from '../lib/httpError';
import { isEncryptedFile, readSecureJson, writeSecureJson } from '../lib/secureStore';

export interface StorageState {
  cookies: Array<Record<string, unknown> & { name: string; domain: string; expires?: number }>;
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
}

export const StorageStateSchema = z.object({
  cookies: z
    .array(
      z
        .object({
          name: z.string().min(1),
          value: z.string(),
          domain: z.string().min(1),
          path: z.string().default('/'),
          expires: z.number().optional(),
          httpOnly: z.boolean().optional(),
          secure: z.boolean().optional(),
          sameSite: z.enum(['Strict', 'Lax', 'None']).optional(),
        })
        .passthrough(),
    )
    .max(2000),
  origins: z
    .array(
      z.object({
        origin: z.string(),
        localStorage: z.array(z.object({ name: z.string(), value: z.string() })).default([]),
      }),
    )
    .default([]),
});

interface ProviderConfig {
  loginUrl: string;
  verifyUrl: string;
  cookieDomain: string;
  authCookies: string[];
  enabled: () => boolean;
  isSignedOutUrl: (url: string) => boolean;
}

const PROVIDERS: Record<SessionProvider, ProviderConfig> = {
  linkedin: {
    loginUrl: 'https://www.linkedin.com/login',
    verifyUrl: 'https://www.linkedin.com/feed/',
    cookieDomain: 'linkedin.com',
    authCookies: ['li_at'],
    enabled: () => env.LINKEDIN_AUTH_ENABLED,
    isSignedOutUrl: (url) => /linkedin\.com\/(login|checkpoint|authwall|uas\/login)/i.test(url),
  },
  google: {
    loginUrl: 'https://accounts.google.com/',
    verifyUrl: 'https://myaccount.google.com/',
    cookieDomain: 'google.com',
    authCookies: ['SID', '__Secure-1PSID', '__Secure-3PSID'],
    enabled: () => env.GOOGLE_AUTH_ENABLED,
    isSignedOutUrl: (url) =>
      /accounts\.google\.com\/(v3\/)?signin|ServiceLogin|accounts\.google\.com\/InteractiveLogin/i.test(
        url,
      ),
  },
};

interface PendingLogin {
  id: string;
  provider: SessionProvider;
  browser: Browser;
  context: BrowserContext;
  startedAt: Date;
  timer: NodeJS.Timeout;
}

const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Stores LinkedIn/Google browser sessions (Playwright storage state) used by the
 * application agent. Sessions are encrypted at rest when DATA_ENCRYPTION_KEY is set.
 */
export class SessionService {
  private static pending = new Map<string, PendingLogin>();

  has(provider: SessionProvider): boolean {
    return PROVIDERS[provider].enabled() && fs.existsSync(paths.session(provider));
  }

  read(provider: SessionProvider): StorageState | null {
    if (!this.has(provider)) return null;
    try {
      return readSecureJson<StorageState>(paths.session(provider));
    } catch (error) {
      console.warn(
        `[sessions] failed to read ${provider} session: ${error instanceof Error ? error.message : error}`,
      );
      return null;
    }
  }

  status(provider: SessionProvider) {
    const config = PROVIDERS[provider];
    const filePath = paths.session(provider);
    const saved = fs.existsSync(filePath);
    const state = saved ? this.read(provider) : null;
    const authCookies = (state?.cookies || []).filter(
      (cookie) =>
        config.authCookies.includes(cookie.name) && cookie.domain.includes(config.cookieDomain),
    );
    const expiries = authCookies
      .map((cookie) => Number(cookie.expires))
      .filter((value) => Number.isFinite(value) && value > 0);
    const expiresAt = expiries.length ? new Date(Math.min(...expiries) * 1000) : undefined;

    return {
      provider,
      enabled: config.enabled(),
      saved,
      readable: Boolean(state),
      encryptedAtRest: saved ? isEncryptedFile(filePath) : false,
      savedAt: saved ? fs.statSync(filePath).mtime.toISOString() : undefined,
      cookieCount: state?.cookies.length ?? 0,
      hasAuthCookie: authCookies.length > 0,
      authCookieExpiresAt: expiresAt?.toISOString(),
      expired: expiresAt ? expiresAt.getTime() < Date.now() : undefined,
      interactiveLoginAvailable: browserInteractiveEnabled,
    };
  }

  save(provider: SessionProvider, input: unknown) {
    const parsed = StorageStateSchema.parse(input);
    const config = PROVIDERS[provider];
    const hasProviderCookie = parsed.cookies.some((cookie) =>
      cookie.domain.includes(config.cookieDomain),
    );
    if (!hasProviderCookie) {
      throw new HttpError(
        400,
        `Storage state has no cookies for ${config.cookieDomain}. Log in first, then export the session.`,
      );
    }
    writeSecureJson(paths.session(provider), parsed);
    return this.status(provider);
  }

  remove(provider: SessionProvider): boolean {
    const filePath = paths.session(provider);
    if (!fs.existsSync(filePath)) return false;
    fs.rmSync(filePath);
    return true;
  }

  /** Headless check that the saved session is still signed in. */
  async verify(provider: SessionProvider) {
    const state = this.read(provider);
    if (!state) {
      return { provider, valid: false, reason: 'No saved session' };
    }

    const browser = await chromium.launch({
      headless: true,
      channel: env.BROWSER_CHANNEL || undefined,
    });
    try {
      const context = await browser.newContext({
        storageState: state as BrowserContextOptions['storageState'],
      });
      const page = await context.newPage();
      await page.goto(PROVIDERS[provider].verifyUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
      await page.waitForTimeout(1_500);
      const finalUrl = page.url();
      const valid = !PROVIDERS[provider].isSignedOutUrl(finalUrl);
      return {
        provider,
        valid,
        finalUrl,
        reason: valid ? 'Session is signed in' : 'Redirected to sign-in; session expired',
      };
    } finally {
      await browser.close().catch(() => undefined);
    }
  }

  /**
   * Interactive login: opens a visible browser on the API host. The user signs in
   * (OTP/CAPTCHA included) and then calls completeLogin to persist the session.
   * Only works where the API host has a display (local machine), never headless servers.
   */
  async startLogin(provider: SessionProvider) {
    if (!browserInteractiveEnabled) {
      throw new HttpError(
        409,
        'Interactive login is disabled on this host (BROWSER_INTERACTIVE_ENABLED=false). ' +
          'Run `bun run session <provider>` on a machine with a browser, or PUT the storage state JSON to /sessions/:provider.',
      );
    }
    if (!PROVIDERS[provider].enabled()) {
      throw new HttpError(409, `${provider} auth is disabled by configuration.`);
    }

    for (const existing of SessionService.pending.values()) {
      if (existing.provider === provider) await this.cancelLogin(existing.id);
    }

    const browser = await chromium.launch({
      headless: false,
      channel: env.BROWSER_CHANNEL || undefined,
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(PROVIDERS[provider].loginUrl, { waitUntil: 'domcontentloaded' });

    const id = crypto.randomUUID();
    const timer = setTimeout(() => void this.cancelLogin(id), LOGIN_TIMEOUT_MS);
    timer.unref();
    SessionService.pending.set(id, {
      id,
      provider,
      browser,
      context,
      startedAt: new Date(),
      timer,
    });

    return {
      loginId: id,
      provider,
      expiresAt: new Date(Date.now() + LOGIN_TIMEOUT_MS).toISOString(),
      next: `Sign in inside the opened browser window, then POST /sessions/${provider}/login/${id}/complete`,
    };
  }

  async completeLogin(provider: SessionProvider, loginId: string) {
    const pending = SessionService.pending.get(loginId);
    if (!pending || pending.provider !== provider) {
      throw new HttpError(404, 'Login attempt not found or expired. Start a new one.');
    }
    const state = await pending.context.storageState();
    await this.cancelLogin(loginId);
    return this.save(provider, state);
  }

  async cancelLogin(loginId: string): Promise<boolean> {
    const pending = SessionService.pending.get(loginId);
    if (!pending) return false;
    SessionService.pending.delete(loginId);
    clearTimeout(pending.timer);
    await pending.browser.close().catch(() => undefined);
    return true;
  }

  static async closeAll(): Promise<void> {
    await Promise.all(
      [...SessionService.pending.values()].map(async (pending) => {
        clearTimeout(pending.timer);
        await pending.browser.close().catch(() => undefined);
      }),
    );
    SessionService.pending.clear();
  }
}
