import fs from 'node:fs';
import path from 'node:path';
import { env } from './env';

export type ResumeIdentity = 'primary' | 'secondary';
export type SessionProvider = 'linkedin' | 'google';

export const RESUME_IDENTITIES: readonly ResumeIdentity[] = ['primary', 'secondary'];
export const SESSION_PROVIDERS: readonly SessionProvider[] = ['linkedin', 'google'];

/** Resolve a possibly-relative path against the process working directory. */
export function resolveFromCwd(input: string): string {
  return path.isAbsolute(input) ? input : path.resolve(process.cwd(), input);
}

export function dataDir(): string {
  return resolveFromCwd(env.DATA_DIR);
}

function inData(...segments: string[]): string {
  return path.join(dataDir(), ...segments);
}

/**
 * All runtime file locations. Every path lives under DATA_DIR unless an explicit
 * env override is set, so a single mounted volume holds all state in production.
 */
export const paths = {
  resumePdf(identity: ResumeIdentity = 'primary'): string {
    const override = identity === 'primary' ? env.RESUME_FILE_PATH : env.SECONDARY_RESUME_FILE_PATH;
    return override ? resolveFromCwd(override) : inData('resume', `${identity}.pdf`);
  },
  resumeText(identity: ResumeIdentity = 'primary'): string {
    const override = identity === 'primary' ? env.RESUME_TEXT_PATH : env.SECONDARY_RESUME_TEXT_PATH;
    const fileName = identity === 'primary' ? 'resume.txt' : 'resume.secondary.txt';
    return override ? resolveFromCwd(override) : inData('profile', fileName);
  },
  candidateProfile(identity: ResumeIdentity = 'primary'): string {
    const override =
      identity === 'primary' ? env.CANDIDATE_PROFILE_PATH : env.SECONDARY_CANDIDATE_PROFILE_PATH;
    const fileName =
      identity === 'primary' ? 'candidateProfile.json' : 'candidateProfile.secondary.json';
    return override ? resolveFromCwd(override) : inData('profile', fileName);
  },
  manualProfile(): string {
    return env.MANUAL_PROFILE_PATH
      ? resolveFromCwd(env.MANUAL_PROFILE_PATH)
      : inData('profile', 'manualProfile.json');
  },
  session(provider: SessionProvider): string {
    const override =
      provider === 'linkedin' ? env.LINKEDIN_STORAGE_STATE_PATH : env.GOOGLE_STORAGE_STATE_PATH;
    return override ? resolveFromCwd(override) : inData('auth', `${provider}.json`);
  },
  previewsDir(): string {
    return inData('previews');
  },
  exportsDir(): string {
    return inData('exports');
  },
};

/** Write a file atomically (tmp + rename) with restrictive permissions. */
export function writeFileAtomic(filePath: string, contents: string | Buffer, mode = 0o600): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, contents, { mode });
  fs.renameSync(tmp, filePath);
}

/** True when `candidate` is inside `root` (prevents path traversal). */
export function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}
