<script lang="ts">
  import { enhance } from '$app/forms';
  import type { ActionData } from './$types';

  let { form }: { form: ActionData } = $props();
  let submitting = $state(false);
</script>

<main>
  <form
    method="POST"
    use:enhance={() => {
      submitting = true;
      return async ({ update }) => {
        await update();
        submitting = false;
      };
    }}
  >
    <div class="logo">◆</div>
    <h1>OmniVoice</h1>
    <p class="sub">Enter the password to open the dashboard.</p>

    <input
      type="password"
      name="password"
      placeholder="Password"
      autocomplete="current-password"
    />

    {#if form?.error}<p class="error">{form.error}</p>{/if}

    <button type="submit" disabled={submitting}>{submitting ? 'Checking…' : 'Enter'}</button>
  </form>
</main>

<style>
  :global(body) {
    margin: 0;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #f4f6fb;
    color: #1a1f36;
  }
  main { min-height: 100vh; display: grid; place-items: center; padding: 1.25rem; }
  form { width: 100%; max-width: 360px; background: #fff; border: 1px solid #e6eaf1; border-radius: 16px; padding: 2rem 1.75rem; box-shadow: 0 8px 30px rgba(16,24,40,0.08); text-align: center; }
  .logo { font-size: 1.8rem; color: #2563eb; margin-bottom: 0.4rem; }
  h1 { margin: 0; font-size: 1.35rem; letter-spacing: -0.02em; color: #111827; }
  .sub { margin: 0.4rem 0 1.25rem; color: #6b7280; font-size: 0.88rem; }
  input {
    width: 100%; box-sizing: border-box; background: #fff; border: 1px solid #d8dee9;
    border-radius: 10px; color: #1a1f36; padding: 0.65rem 0.75rem; font: inherit; margin-bottom: 0.9rem; text-align: left;
  }
  input:focus { outline: none; border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,0.12); }
  button { width: 100%; background: #2563eb; border: none; color: white; font-weight: 600; padding: 0.7rem; border-radius: 10px; cursor: pointer; font-size: 1rem; }
  button:hover { background: #1d4ed8; }
  button:disabled { opacity: 0.6; cursor: default; }
  .error { color: #dc2626; font-size: 0.85rem; margin: -0.3rem 0 0.9rem; text-align: left; }
</style>
