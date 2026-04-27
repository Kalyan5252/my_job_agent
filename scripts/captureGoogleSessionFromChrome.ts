import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { chromium } from 'playwright';
import { env } from '../src/config/env';

async function main(): Promise<void> {
  if (!env.GOOGLE_AUTH_ENABLED) {
    console.log('Google auth flow is disabled. Set GOOGLE_AUTH_ENABLED=true in .env.');
    return;
  }

  const storagePath = resolveStoragePath(env.GOOGLE_STORAGE_STATE_PATH);
  fs.mkdirSync(path.dirname(storagePath), { recursive: true });

  console.log('Use your real Google Chrome for sign-in (recommended for Google security checks).');
  console.log("If Chrome isn't already running with remote debugging, launch it with:");
  console.log(
    '/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.codex-google-auth"',
  );
  console.log('');
  console.log('Then sign in to https://accounts.google.com in that Chrome window.');
  console.log('');

  const rl = readline.createInterface({ input, output });
  await rl.question('Press Enter after Chrome is running and you are signed in...');
  rl.close();

  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  try {
    const contexts = browser.contexts();
    if (contexts.length === 0) {
      throw new Error('No Chrome browser context found via CDP.');
    }

    const context = contexts[0];
    await context.storageState({ path: storagePath });
    console.log(`Google session captured to: ${storagePath}`);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

function resolveStoragePath(configuredPath: string): string {
  return path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(process.cwd(), configuredPath);
}

main().catch((error) => {
  console.error('Failed to capture Google session:', error);
  process.exit(1);
});
