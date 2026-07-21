import { redirect, type Handle } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { AUTH_COOKIE, isValidToken } from '$lib/server/auth';

const API_URL = env.API_URL ?? 'http://localhost:9001';
const API_TOKEN = env.API_TOKEN ?? '';

// Server-side proxy for /api + /health. This is the ONLY path to the backend in
// production (the Vite proxy in vite.config.ts only exists in `vite dev`). It
// forwards same-origin browser requests to the API and injects the backend
// token server-side, so API_TOKEN never reaches browser JS.
async function proxyToApi(request: Request, pathname: string, search: string): Promise<Response> {
  const target = `${API_URL}${pathname}${search}`;
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('connection');
  headers.delete('content-length'); // recomputed from the buffered body
  if (API_TOKEN) headers.set('x-api-token', API_TOKEN);

  const init: RequestInit = { method: request.method, headers };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    // Buffer the request body rather than streaming it. Streaming (duplex:'half')
    // is brittle under undici and surfaces as "TypeError: fetch failed" on
    // multipart uploads; request bodies here (audio clips) are small enough to
    // buffer. The RESPONSE is still streamed (SSE) via res.body below.
    init.body = await request.arrayBuffer();
  }

  const res = await fetch(target, init);
  // Strip hop-by-hop headers; keep content-type + streaming semantics (SSE).
  const outHeaders = new Headers(res.headers);
  outHeaders.delete('content-encoding');
  outHeaders.delete('content-length');
  return new Response(res.body, { status: res.status, headers: outHeaders });
}

export const handle: Handle = async ({ event, resolve }) => {
  const { pathname, search } = event.url;
  const isApi = pathname === '/api' || pathname.startsWith('/api/');
  const isHealth = pathname === '/health';

  const authed = isValidToken(event.cookies.get(AUTH_COOKIE));

  if (isApi || isHealth) {
    // /api always requires login; /health stays open so the status banner works
    // on the login screen.
    if (isApi && !authed) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }
    try {
      return await proxyToApi(event.request, pathname, search);
    } catch (err) {
      return new Response(JSON.stringify({ error: 'API unreachable', detail: String(err) }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      });
    }
  }

  // Page routes: login is mandatory.
  if (pathname === '/login' || pathname === '/logout') return resolve(event);
  if (!authed) redirect(302, '/login');
  return resolve(event);
};
