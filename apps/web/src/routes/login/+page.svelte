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
    <h1>OmniVoice <span class="plus">+</span> RVC</h1>
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
    background: #0e0f13;
    color: #e7e8ea;
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }
  main { min-height: 100vh; display: grid; place-items: center; padding: 1.25rem; }
  form { width: 100%; max-width: 340px; background: #16181f; border: 1px solid #23262f; border-radius: 14px; padding: 1.5rem; }
  h1 { margin: 0; font-size: 1.5rem; letter-spacing: -0.02em; }
  .plus { color: #7c5cff; }
  .sub { margin: 0.35rem 0 1.1rem; color: #9a9ca3; font-size: 0.88rem; }
  input {
    width: 100%; box-sizing: border-box; background: #0e0f13; border: 1px solid #2a2d37;
    border-radius: 8px; color: #e7e8ea; padding: 0.6rem 0.7rem; font: inherit; margin-bottom: 0.9rem;
  }
  button { width: 100%; background: #7c5cff; border: none; color: white; font-weight: 600; padding: 0.7rem; border-radius: 10px; cursor: pointer; font-size: 1rem; }
  button:disabled { opacity: 0.6; cursor: default; }
  .error { color: #ff8a8a; font-size: 0.85rem; margin: -0.3rem 0 0.9rem; }
</style>
