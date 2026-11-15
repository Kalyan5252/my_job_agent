import crypto from 'node:crypto';
import { apiKeys as envApiKeys, env } from '../config/env';

export interface Principal {
  type: 'api_key' | 'user' | 'anonymous';
  subject: string;
  expiresAt?: string;
}

export interface AuthConfig {
  disabled: boolean;
  apiKeys: string[];
  adminUsername: string;
  adminPasswordHash?: string;
  tokenSecret?: string;
  tokenTtlSeconds: number;
}

export function authConfigFromEnv(): AuthConfig {
  return {
    disabled: env.AUTH_DISABLED && env.NODE_ENV !== 'production',
    apiKeys: envApiKeys,
    adminUsername: env.ADMIN_USERNAME,
    adminPasswordHash: env.ADMIN_PASSWORD_HASH,
    tokenSecret: env.AUTH_TOKEN_SECRET,
    tokenTtlSeconds: env.AUTH_TOKEN_TTL_SECONDS,
  };
}

// ---------------------------------------------------------------------------
// Password hashing (scrypt). Format: scrypt$N$r$p$<salt b64>$<hash b64>
// ---------------------------------------------------------------------------

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    hash.toString('base64'),
  ].join('$');
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// ---------------------------------------------------------------------------
// Tokens (compact HS256 JWT)
// ---------------------------------------------------------------------------

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(data: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const ah = crypto.createHash('sha256').update(a).digest();
  const bh = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ah, bh);
}

export class AuthService {
  constructor(private readonly config: AuthConfig = authConfigFromEnv()) {}

  get disabled(): boolean {
    return this.config.disabled;
  }

  get passwordLoginEnabled(): boolean {
    return Boolean(this.config.adminPasswordHash && this.config.tokenSecret);
  }

  get configured(): boolean {
    return this.config.apiKeys.length > 0 || this.passwordLoginEnabled;
  }

  login(
    username: string,
    password: string,
  ): { accessToken: string; tokenType: 'Bearer'; expiresAt: string; expiresIn: number } | null {
    if (!this.passwordLoginEnabled) return null;
    // Always run the hash check so timing does not reveal whether the username exists.
    const passwordOk = verifyPassword(password, this.config.adminPasswordHash!);
    const userOk = safeEqual(username, this.config.adminUsername);
    if (!passwordOk || !userOk) return null;
    return this.issueToken(username);
  }

  issueToken(subject: string) {
    const now = Math.floor(Date.now() / 1000);
    const exp = now + this.config.tokenTtlSeconds;
    const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = b64url(
      JSON.stringify({ sub: subject, iat: now, exp, jti: crypto.randomUUID() }),
    );
    const signature = sign(`${header}.${payload}`, this.config.tokenSecret!);
    return {
      accessToken: `${header}.${payload}.${signature}`,
      tokenType: 'Bearer' as const,
      expiresIn: this.config.tokenTtlSeconds,
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  }

  verifyToken(token: string): Principal | null {
    if (!this.config.tokenSecret) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, payload, signature] = parts;
    if (!safeEqual(signature, sign(`${header}.${payload}`, this.config.tokenSecret))) return null;
    try {
      const decodedHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
      if (decodedHeader.alg !== 'HS256') return null;
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
        sub?: string;
        exp?: number;
      };
      if (!claims.sub || !claims.exp || claims.exp * 1000 < Date.now()) return null;
      return {
        type: 'user',
        subject: claims.sub,
        expiresAt: new Date(claims.exp * 1000).toISOString(),
      };
    } catch {
      return null;
    }
  }

  matchApiKey(candidate: string): Principal | null {
    const index = this.config.apiKeys.findIndex((key) => safeEqual(candidate, key));
    if (index === -1) return null;
    return { type: 'api_key', subject: `api-key-${index + 1}` };
  }

  /** Resolve a principal from request headers; null means unauthenticated. */
  authenticate(headers: Record<string, string | string[] | undefined>): Principal | null {
    if (this.config.disabled) return { type: 'anonymous', subject: 'auth-disabled' };

    const apiKeyHeader = headers['x-api-key'];
    const apiKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
    if (apiKey) return this.matchApiKey(apiKey.trim());

    const authorization = headers.authorization;
    const value = Array.isArray(authorization) ? authorization[0] : authorization;
    const match = value?.match(/^Bearer\s+(.+)$/i);
    if (!match) return null;
    const credential = match[1].trim();
    return this.matchApiKey(credential) ?? this.verifyToken(credential);
  }
}
