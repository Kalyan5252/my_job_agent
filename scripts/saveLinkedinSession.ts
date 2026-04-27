import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { chromium, firefox } from "playwright";
import { env } from "../src/config/env";

async function main(): Promise<void> {
  if (!env.LINKEDIN_AUTH_ENABLED) {
    console.log("LinkedIn auth flow is disabled. Set LINKEDIN_AUTH_ENABLED=true in .env.");
    return;
  }

  const storagePath = resolveStoragePath(env.LINKEDIN_STORAGE_STATE_PATH);
  fs.mkdirSync(path.dirname(storagePath), { recursive: true });
  let browser
  try{
   browser = await chromium.launch({ headless: false, slowMo: 50 });

  }catch(e){
    try{
      console.error("Failed to launch Chromium with default settings retrying with firefox...");
      browser = await firefox.launch({ headless: false, slowMo: 50 });
    }
    catch(e){
      console.error("Failed to launch Firefox as well. Please ensure you have at least one of these browsers installed and try again.");
      throw e;
    }
  }
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    console.log("Opening LinkedIn login page...");
    await page.goto("https://www.linkedin.com/login", { waitUntil: "domcontentloaded" });
    console.log("");
    console.log("1) Log in to LinkedIn in the opened browser window.");
    console.log("2) If prompted, complete OTP/CAPTCHA.");
    console.log("3) Open any LinkedIn jobs page once login is complete.");
    console.log("");

    const rl = readline.createInterface({ input, output });
    await rl.question("Press Enter here after login is complete to save session...");
    rl.close();

    await context.storageState({ path: storagePath });
    console.log(`LinkedIn session saved to: ${storagePath}`);
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
  console.error("Failed to save LinkedIn session:", error);
  process.exit(1);
});
