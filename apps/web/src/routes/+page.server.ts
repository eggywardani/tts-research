import { authEnabled } from '$lib/server/auth';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
  return { authEnabled: authEnabled() };
};
