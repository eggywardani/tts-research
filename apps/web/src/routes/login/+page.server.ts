import { fail, redirect } from '@sveltejs/kit';
import { AUTH_COOKIE, authEnabled, checkPassword, hashToken } from '$lib/server/auth';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
  // If auth is off, there's nothing to log into.
  if (!authEnabled()) redirect(302, '/');
  return {};
};

export const actions: Actions = {
  default: async ({ request, cookies }) => {
    const data = await request.formData();
    const password = String(data.get('password') ?? '');

    if (!checkPassword(password)) {
      return fail(401, { error: 'Wrong password.' });
    }

    cookies.set(AUTH_COOKIE, hashToken(password), {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 60 * 60 * 24 * 30, // 30 days
    });

    redirect(302, '/');
  },
};
