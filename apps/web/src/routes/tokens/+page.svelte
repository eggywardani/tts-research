<script lang="ts">
  import { onMount } from 'svelte';
  import {
    fetchApiKeys,
    createApiKey,
    toggleApiKey,
    deleteApiKey,
    type ApiKey,
  } from '$lib/api';

  let keys = $state<ApiKey[]>([]);
  let loading = $state(true);
  let error = $state('');

  let newName = $state('');
  let creating = $state(false);
  let revealed = $state<Record<string, boolean>>({});
  let copied = $state<string | null>(null);

  async function load() {
    loading = true;
    error = '';
    try {
      keys = await fetchApiKeys();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  onMount(load);

  async function create() {
    const name = newName.trim();
    if (!name || creating) return;
    creating = true;
    error = '';
    try {
      const key = await createApiKey(name);
      keys = [key, ...keys];
      revealed[key.id] = true; // show the new token immediately
      newName = '';
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      creating = false;
    }
  }

  async function toggle(k: ApiKey) {
    try {
      await toggleApiKey(k.id, !k.disabled);
      k.disabled = !k.disabled;
      keys = keys;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function remove(k: ApiKey) {
    if (!confirm(`Delete token “${k.name}”? Any client using it will stop working.`)) return;
    try {
      await deleteApiKey(k.id);
      keys = keys.filter((x) => x.id !== k.id);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function copy(k: ApiKey) {
    try {
      await navigator.clipboard.writeText(k.token);
      copied = k.id;
      setTimeout(() => (copied = copied === k.id ? null : copied), 1500);
    } catch {
      /* clipboard blocked — user can still reveal + select manually */
    }
  }

  const mask = (t: string) => `${t.slice(0, 8)}${'•'.repeat(12)}${t.slice(-4)}`;
  const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleString() : 'never');
</script>

<div class="wrap">
  <section class="card">
    <h3>Create a token</h3>
    <p class="hint">
      Each client gets its own token. It grants access to every API endpoint except token
      management. Send it as <code>Authorization: Bearer &lt;token&gt;</code>,
      <code>x-api-token</code>, or <code>?token=</code> directly to the API service.
    </p>
    <form class="create" onsubmit={(e) => { e.preventDefault(); create(); }}>
      <input placeholder="Client name (e.g. mobile-app, partner-x)" bind:value={newName} />
      <button type="submit" disabled={creating || !newName.trim()}>
        {creating ? 'Creating…' : 'Create token'}
      </button>
    </form>
  </section>

  {#if error}
    <div class="err">{error}</div>
  {/if}

  <section class="card">
    <h3>Tokens {#if keys.length}<span class="count">{keys.length}</span>{/if}</h3>

    {#if loading}
      <p class="muted">Loading…</p>
    {:else if keys.length === 0}
      <p class="muted">No tokens yet. Create one above to let a client call the API.</p>
    {:else}
      <div class="list">
        {#each keys as k (k.id)}
          <div class="row" class:disabled={k.disabled}>
            <div class="main">
              <div class="name-row">
                <span class="name">{k.name}</span>
                {#if k.disabled}<span class="badge off">disabled</span>{:else}<span class="badge on">active</span>{/if}
              </div>
              <div class="token">
                <code>{revealed[k.id] ? k.token : mask(k.token)}</code>
                <button class="link" onclick={() => (revealed[k.id] = !revealed[k.id])}>
                  {revealed[k.id] ? 'Hide' : 'Reveal'}
                </button>
                <button class="link" onclick={() => copy(k)}>{copied === k.id ? 'Copied!' : 'Copy'}</button>
              </div>
              <div class="meta">
                {k.request_count.toLocaleString()} requests · last used {fmtDate(k.last_used_at)} · created {fmtDate(k.created_at)}
              </div>
            </div>
            <div class="actions">
              <button class="btn" onclick={() => toggle(k)}>{k.disabled ? 'Enable' : 'Disable'}</button>
              <button class="btn danger" onclick={() => remove(k)}>Delete</button>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </section>
</div>

<style>
  .wrap { max-width: 860px; display: flex; flex-direction: column; gap: 1.25rem; }
  .card { background: #fff; border: 1px solid #e6eaf1; border-radius: 14px; padding: 1.4rem; box-shadow: 0 1px 2px rgba(16,24,40,0.04); }
  .card h3 { margin: 0 0 0.6rem; font-size: 1rem; color: #111827; display: flex; align-items: center; gap: 0.5rem; }
  .count { background: #eef4ff; color: #2563eb; font-size: 0.72rem; font-weight: 700; padding: 0.1rem 0.5rem; border-radius: 999px; }
  .hint { font-size: 0.82rem; color: #64748b; line-height: 1.5; margin: 0 0 1rem; }
  .hint code { background: #f1f5f9; padding: 0.05rem 0.35rem; border-radius: 5px; font-size: 0.78rem; color: #334155; }

  .create { display: flex; gap: 0.6rem; }
  .create input { flex: 1; background: #fff; border: 1px solid #d8dee9; border-radius: 9px; color: #1a1f36; padding: 0.55rem 0.7rem; font: inherit; }
  .create input:focus { outline: none; border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,0.12); }
  .create button { background: #2563eb; border: none; color: #fff; font-weight: 600; padding: 0.55rem 1.1rem; border-radius: 9px; cursor: pointer; white-space: nowrap; }
  .create button:disabled { opacity: 0.5; cursor: not-allowed; }

  .err { background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c; border-radius: 9px; padding: 0.7rem 0.9rem; font-size: 0.85rem; }

  .list { display: flex; flex-direction: column; gap: 0.75rem; }
  .row { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; padding: 0.9rem 1rem; border: 1px solid #eef1f6; border-radius: 11px; background: #fbfcfe; }
  .row.disabled { opacity: 0.62; }
  .main { min-width: 0; flex: 1; }
  .name-row { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.35rem; }
  .name { font-weight: 600; color: #111827; }
  .badge { font-size: 0.66rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; padding: 0.1rem 0.45rem; border-radius: 999px; }
  .badge.on { background: #dcfce7; color: #15803d; }
  .badge.off { background: #f1f5f9; color: #64748b; }
  .token { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; margin-bottom: 0.35rem; }
  .token code { font-size: 0.8rem; color: #334155; background: #f1f5f9; padding: 0.25rem 0.5rem; border-radius: 6px; word-break: break-all; }
  .meta { font-size: 0.74rem; color: #94a3b8; }
  .link { border: none; background: transparent; color: #2563eb; font-size: 0.76rem; font-weight: 600; cursor: pointer; padding: 0; }
  .link:hover { text-decoration: underline; }

  .actions { display: flex; gap: 0.4rem; flex-shrink: 0; }
  .btn { background: #fff; border: 1px solid #e2e8f0; color: #475569; font-size: 0.8rem; font-weight: 500; padding: 0.4rem 0.7rem; border-radius: 8px; cursor: pointer; }
  .btn:hover { background: #f8fafc; }
  .btn.danger:hover { background: #fef2f2; border-color: #fecaca; color: #dc2626; }

  .muted { color: #94a3b8; font-size: 0.86rem; }
</style>
