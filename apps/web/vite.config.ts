import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// Note: /api and /health are proxied to the backend server-side in
// hooks.server.ts (so it works in prod too, not just `vite dev`).
export default defineConfig({
  plugins: [sveltekit()],
});
