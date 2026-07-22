import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// The /api proxy lives in src/hooks.server.ts so dev and the
// adapter-node production build behave identically (and API_TOKEN injection +
// the login gate apply in both). No Vite dev proxy needed.
export default defineConfig({
  plugins: [sveltekit()],
});
