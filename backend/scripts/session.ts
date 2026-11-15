/**
 * Log in to LinkedIn/Google in a real browser on THIS machine and store the session
 * for the job agent. Works against a remote (headless) production API.
 *
 *   bun run session linkedin                 # log in, then PUT to $JOB_AGENT_API_URL/sessions/linkedin
 *   bun run session google --chrome-cdp      # capture from your real Chrome (port 9222); best for Google
 *   bun run session linkedin --local         # write the encrypted session straight into DATA_DIR
 *
 * Env: JOB_AGENT_API_URL (default http://localhost:3000) and JOB_AGENT_API_KEY or JOB_AGENT_TOKEN.
 */
import readline from 'node:readline/promises';
import { chromium, firefox, type Browser, type BrowserContext } from 'playwright';
import { SESSION_PROVIDERS, type SessionProvider } from '../src/config/paths';

const LOGIN_URLS: Record<SessionProvider, string> = {
  linkedin: 'https://www.linkedin.com/login',
  google: 'https://accounts.google.com/',
};

async function main() {
  const provider = process.argv[2] as SessionProvider;
  if (!SESSION_PROVIDERS.includes(provider)) {
    console.error(
      `Usage: bun run session <${SESSION_PROVIDERS.join('|')}> [--chrome-cdp] [--local]`,
    );
    process.exit(1);
  }
  const useCdp = process.argv.includes('--chrome-cdp');
  const local = process.argv.includes('--local');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  let browser: Browser;
  let context: BrowserContext;
  if (useCdp) {
    console.log('Start Chrome with remote debugging, sign in, then come back here:');
    console.log(
      '  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.job-agent-chrome"',
    );
    await rl.question('Press Enter once you are signed in... ');
    browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
    context = browser.contexts()[0];
    if (!context) throw new Error('No Chrome context found over CDP.');
  } else {
    browser = await chromium
      .launch({ headless: false })
      .catch(() => firefox.launch({ headless: false }));
    context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(LOGIN_URLS[provider], { waitUntil: 'domcontentloaded' });
    console.log(`Sign in to ${provider} in the opened window (complete OTP/CAPTCHA yourself).`);
    await rl.question('Press Enter here once you are fully signed in... ');
  }
  rl.close();

  const state = await context.storageState();
  if (!useCdp) await browser.close();

  if (local) {
    const { SessionService } = await import('../src/services/session.service');
    const status = new SessionService().save(provider, state);
    console.log('Saved locally:', status);
    return;
  }

  const baseUrl = (process.env.JOB_AGENT_API_URL || 'http://localhost:3000').replace(/\/$/, '');
  const credential = process.env.JOB_AGENT_API_KEY || process.env.JOB_AGENT_TOKEN;
  if (!credential)
    throw new Error('Set JOB_AGENT_API_KEY or JOB_AGENT_TOKEN to upload the session.');
  const response = await fetch(`${baseUrl}/sessions/${provider}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
    body: JSON.stringify(state),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Upload failed (${response.status}): ${body}`);
  console.log(`Uploaded ${provider} session to ${baseUrl}:`, body);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
