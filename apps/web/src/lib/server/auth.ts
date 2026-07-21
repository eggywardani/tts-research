import { env } from '$env/dynamic/private';
import { createHmac, timingSafeEqual } from 'node:crypto';

export const AUTH_COOKIE = 'auth_token';

// Auth is mandatory — the dashboard always requires login. When AUTH_PASSWORD is
// unset we fall back to a default so login/logout always work out of the box.
// CHANGE THIS in production by setting AUTH_PASSWORD.
const DEFAULT_PASSWORD = 'admin';

/** Configured passwords (comma-separated), or the default when none are set. */
export function getPasswords(): string[] {
  const configured = (env.AUTH_PASSWORD ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  return configured.length > 0 ? configured : [DEFAULT_PASSWORD];
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
