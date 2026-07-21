import { redirect, type Handle } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { AUTH_COOKIE, authEnabled, isValidToken } from '$lib/server/auth';

const API_URL = env.API_URL ?? 'http://localhost:9001';
const API_TOKEN = env.API_TOKEN ?? '';

// Hop-by-hop / host headers that must not be forwarded verbatim.
const STRIP = new Set(['host', 'connection', 'content-length']);

/** Forward /api + /health to the backend, injecting the API token server-side so
 *  it never reaches browser JS. Works in dev AND in the prod node server (unlike
 *  the Vite dev proxy, which only runs under `vite dev`). */
async function proxy(event: Parameters<Handle>[0]['event']): Promise<Response> {
  const target = API_URL + event.url.pathname + event.url.search;

  const headers = new Headers();
  for (const [k, v] of event.request.headers) {
    if (!STRIP.has(k.toLowerCase())) headers.set(k, v);
  }
  if (API_TOKEN) headers.set('x-api-token', API_TOKEN);

  const method = event.request.method;
  const hasBody = method !== 'GET' && method !== 'HEAD';

  const res = await fetch(target, {
    method,
    headers,
    body: hasBody ? event.request.body : undefined,
    // @ts-expect-error — required by undici/bun to stream a request body
    duplex: hasBody ? 'half' : undefined,
    redirect: 'manual',
  });

  // Pass the (possibly streaming, e.g. SSE) response straight through.
  const outHeaders = new Headers(res.headers);
  outHeaders.delete('content-encoding');
  outHeaders.delete('content-length');
  return new Response(res.body, { status: res.status, headers: outHeaders });
}

export const handle: Handle = async ({ event, resolve }) => {
  const { pathname } = event.url;

  // Same-origin backend calls: proxy them (token injected here).
  if (pathname.startsWith('/api/') || pathname === '/health') {
    return proxy(event);
  }

  // Dashboard password gate. No password configured -> open.
  if (!authEnabled()) return resolve(event);
  if (pathname === '/login' || pathname === '/logout') return resolve(event);
  if (!isValidToken(event.cookies.get(AUTH_COOKIE))) {
    redirect(302, '/login');
  }

  return resolve(event);
};
