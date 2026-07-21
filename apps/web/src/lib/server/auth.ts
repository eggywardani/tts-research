import { env } from '$env/dynamic/private';
import { createHmac, timingSafeEqual } from 'node:crypto';

export const AUTH_COOKIE = 'auth_token';

/** Configured passwords (comma-separated). Empty = auth disabled. */
export function getPasswords(): string[] {
  return (env.AUTH_PASSWORD ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}

export function authEnabled(): boolean {
  return getPasswords().length > 0;
}

function secret(): string {
  return env.AUTH_SECRET || getPasswords().join(':') || 'tts-exp-default';
}

/** Cookie value for a password — HMAC so the raw password never lands in a cookie. */
export function hashToken(password: string): string {
  return createHmac('sha256', secret()).update(password).digest('hex');
}

export function validTokens(): Set<string> {
  return new Set(getPasswords().map(hashToken));
}

export function isValidToken(token: string | undefined): boolean {
  if (!token) return false;
  return validTokens().has(token);
}

/** Constant-time password check. */
export function checkPassword(password: string): boolean {
  const candidate = Buffer.from(hashToken(password));
  for (const valid of validTokens()) {
    const target = Buffer.from(valid);
    if (candidate.length === target.length && timingSafeEqual(candidate, target)) {
      return true;
    }
  }
  return false;
}
