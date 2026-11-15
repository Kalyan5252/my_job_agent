/**
 * Generates ADMIN_PASSWORD_HASH for POST /auth/login and random secrets.
 *   bun run auth:hash-password            (prompts for the password)
 *   bun run auth:hash-password --secrets  (also prints AUTH_TOKEN_SECRET, API key, DATA_ENCRYPTION_KEY)
 */
import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { hashPassword } from '../src/auth/auth.service';

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const password = (
    process.env.ADMIN_PASSWORD_INPUT ?? (await rl.question('New admin password: '))
  ).trim();
  rl.close();
  if (password.length < 12) {
    console.error('Password must be at least 12 characters.');
    process.exit(1);
  }

  console.log(`\nADMIN_PASSWORD_HASH='${hashPassword(password)}'`);
  if (process.argv.includes('--secrets')) {
    console.log(`AUTH_TOKEN_SECRET=${crypto.randomBytes(48).toString('base64url')}`);
    console.log(`API_KEYS=ja_${crypto.randomBytes(32).toString('base64url')}`);
    console.log(`DATA_ENCRYPTION_KEY=${crypto.randomBytes(48).toString('base64url')}`);
  }
  console.log(
    '\nPut these in backend/.env (or your secret manager). Keep the single quotes around the hash.',
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
