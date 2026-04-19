import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { chromium } from "playwright";
import { env } from "../src/config/env";

async function main(): Promise<void> {
  if (!env.GOOGLE_AUTH_ENABLED) {
    console.log("Google auth flow is disabled. Set GOOGLE_AUTH_ENABLED=true in .env.");
    return;
  }

  const storagePath = resolveStoragePath(env.GOOGLE_STORAGE_STATE_PATH);
  fs.mkdirSync(path.dirname(storagePath), { recursive: true });

  const browser = await chromium.launch({ headless: false, slowMo: 60 });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    console.log("Opening Google sign-in page...");
    await page.goto("https://accounts.google.com/signin", { waitUntil: "domcontentloaded" });
    console.log("");
    console.log("1) Sign in with your Google account in opened browser.");
    console.log("2) Complete OTP / 2FA if prompted.");
    console.log("3) Wait until you land on any Google account page.");
    console.log("");

    const rl = readline.createInterface({ input, output });
    await rl.question("Press Enter here after Google login is complete...");
    rl.close();

    await page.goto("https://myaccount.google.com", { waitUntil: "domcontentloaded" });
    const current = page.url().toLowerCase();
    const signedIn = current.includes("myaccount.google.com") || current.includes("accounts.google.com");
    if (!signedIn) {
      throw new Error("Google login verification failed. Please rerun and complete sign-in.");
    }

    await context.storageState({ path: storagePath });
    console.log(`Google session saved to: ${storagePath}`);
  } finally {
    await page.close().catch(() => undefined);
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

function resolveStoragePath(configuredPath: string): string {
  return path.isAbsolute(configuredPath) ? configuredPath : path.resolve(process.cwd(), configuredPath);
}

main().catch((error) => {
  console.error("Failed to save Google session:", error);
  process.exit(1);
});
