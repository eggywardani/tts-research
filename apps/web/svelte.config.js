import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
    // We use SvelteKit as a same-origin proxy for /api (multipart form POSTs).
    // SvelteKit's origin-based CSRF check would reject those; disable it and rely
    // on our own protection instead: the backend API_TOKEN (injected server-side)
    // plus the dashboard password gate.
    csrf: { checkOrigin: false },
  },
};

export default config;
