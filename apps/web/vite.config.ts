import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const API_URL = env.API_URL ?? 'http://localhost:9001';
  const API_TOKEN = env.API_TOKEN ?? '';

  // Attach the backend token server-side so it never reaches browser JS.
  const apiHeaders = API_TOKEN ? { 'x-api-token': API_TOKEN } : undefined;

  return {
    plugins: [sveltekit()],
    server: {
      proxy: {
        // Frontend only ever calls same-origin /api + /health; Vite proxies to Bun.
        '/api': { target: API_URL, changeOrigin: true, headers: apiHeaders },
        '/health': { target: API_URL, changeOrigin: true },
      },
    },
  };
});
