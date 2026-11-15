import crypto from 'node:crypto';
import fs from 'node:fs';
import { env } from '../config/env';
import { writeFileAtomic } from '../config/paths';

const MAGIC = 'JAENC1:';

function encryptionKey(): Buffer | null {
  if (!env.DATA_ENCRYPTION_KEY) return null;
  return crypto.createHash('sha256').update(env.DATA_ENCRYPTION_KEY, 'utf8').digest();
}

export function isEncryptionEnabled(): boolean {
  return Boolean(env.DATA_ENCRYPTION_KEY);
}

export function encryptString(plain: string): string {
  const key = encryptionKey();
  if (!key) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${MAGIC}${Buffer.concat([iv, tag, body]).toString('base64')}`;
}

export function decryptString(stored: string): string {
  if (!stored.startsWith(MAGIC)) return stored; // legacy plaintext file
  const key = encryptionKey();
  if (!key) {
    throw new Error('File is encrypted but DATA_ENCRYPTION_KEY is not set.');
  }
  const raw = Buffer.from(stored.slice(MAGIC.length), 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const body = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

export function isEncryptedFile(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  const fd = fs.openSync(filePath, 'r');
  try {
    const head = Buffer.alloc(MAGIC.length);
    fs.readSync(fd, head, 0, MAGIC.length, 0);
    return head.toString('utf8') === MAGIC;
  } finally {
    fs.closeSync(fd);
  }
}

export function writeSecureJson(filePath: string, value: unknown): void {
  writeFileAtomic(filePath, encryptString(JSON.stringify(value)), 0o600);
}

export function readSecureJson<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  const decoded = decryptString(fs.readFileSync(filePath, 'utf8'));
  return JSON.parse(decoded) as T;
}
