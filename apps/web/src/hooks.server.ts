import { redirect, type Handle } from '@sveltejs/kit';
import { AUTH_COOKIE, authEnabled, isValidToken } from '$lib/server/auth';

export const handle: Handle = async ({ event, resolve }) => {
  // No password configured -> gate disabled (open dashboard).
  if (!authEnabled()) return resolve(event);

  // Always let the login/logout routes through.
  if (event.url.pathname === '/login' || event.url.pathname === '/logout') {
    return resolve(event);
  }

  if (!isValidToken(event.cookies.get(AUTH_COOKIE))) {
    redirect(302, '/login');
  }

  return resolve(event);
};
