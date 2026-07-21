<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchHistory, deleteHistory, clearHistory, type HistoryItem } from '$lib/api';

  let items = $state<HistoryItem[]>([]);
  let loading = $state(true);
  let error = $state('');

  onMount(load);

  async function load() {
    loading = true;
    try {
      items = await fetchHistory(100);
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    } finally {
      loading = false;
    }
  }

  async function remove(it: HistoryItem) {
    try {
      await deleteHistory(it.id);
      items = items.filter((x) => x.id !== it.id);
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    }
  }

  async function clearAll() {
    if (!confirm('Delete ALL history?')) return;
    try {
      await clearHistory();
      items = [];
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    }
  }

  function when(iso: string): string {
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }
</script>

<main>
  <div class="head">
    <h1>Audio history</h1>
    {#if items.length}<button class="clear" onclick={clearAll}>Clear all</button>{/if}
  </div>
  <p class="sub">Every generation is archived here.</p>

  {#if error}<p class="error">{error}</p>{/if}

  {#if loading}
    <p class="muted">Loading…</p>
  {:else if items.length === 0}
    <p class="muted">Nothing generated yet.</p>
  {:else}
    <ul class="list">
      {#each items as it (it.id)}
        <li>
          <div class="top">
            <span class="text">{it.text || '(no text)'}</span>
            <button class="del" onclick={() => remove(it)} aria-label="delete">✕</button>
          </div>
          <div class="meta">
            {when(it.created_at)}
            · {it.engine}{it.rvc ? ' · RVC' : ''}
            {#if it.speaker_name}· voice: {it.speaker_name}{/if}
            {#if it.sample_rate}· {it.sample_rate} Hz{/if}
            {#if it.duration_seconds}· {it.duration_seconds.toFixed(1)}s{/if}
          </div>
          <div class="settings">
            {#if it.params?.mode}<span class="chip">{it.params.mode}</span>{/if}
            {#if it.params?.temperature != null}<span class="chip">temp {it.params.temperature}</span>{/if}
            {#if it.params?.top_p != null}<span class="chip">top_p {it.params.top_p}</span>{/if}
            {#if it.params?.cfg_scale != null}<span class="chip">cfg {it.params.cfg_scale}</span>{/if}
            {#if it.params?.seed != null}<span class="chip">seed {it.params.seed}</span>{/if}
            {#if it.params?.use_rvc}<span class="chip">rvc {it.params.rvc_model || 'on'}{it.params.rvc_pitch ? ` ${it.params.rvc_pitch >= 0 ? '+' : ''}${it.params.rvc_pitch}` : ''}</span>{/if}
          </div>
          {#if it.url}
            <audio controls src={it.url}></audio>
          {:else}
            <span class="muted small">not archived (S3 off)</span>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</main>

<style>
  main { width: 100%; }
  .head { display: flex; align-items: center; justify-content: space-between; }
  h1 { margin: 0; font-size: 1.35rem; letter-spacing: -0.02em; color: #111827; }
  .sub { margin: 0.25rem 0 1.25rem; color: #6b7280; font-size: 0.9rem; }
  .clear { background: #fff; border: 1px solid #fecaca; color: #dc2626; border-radius: 9px; padding: 0.4rem 0.8rem; cursor: pointer; font-size: 0.8rem; font-weight: 500; }
  .clear:hover { background: #fef2f2; }
  .error { color: #dc2626; font-size: 0.85rem; }
  .muted { color: #8a93a6; }
  .small { font-size: 0.78rem; }
  .list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.6rem; }
  .list li { background: #fff; border: 1px solid #e6eaf1; border-radius: 11px; padding: 0.85rem 1rem; box-shadow: 0 1px 2px rgba(16,24,40,0.03); }
  .top { display: flex; justify-content: space-between; gap: 0.75rem; align-items: flex-start; }
  .text { font-size: 0.9rem; color: #1a1f36; }
  .meta { font-size: 0.74rem; color: #8a93a6; margin: 0.35rem 0 0.5rem; }
  .settings { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-bottom: 0.6rem; }
  .chip { font-size: 0.7rem; color: #475569; background: #eef1f6; border: 1px solid #e2e8f0; padding: 0.12rem 0.5rem; border-radius: 999px; }
  .list audio { width: 100%; height: 34px; }
  .del { background: #fff; border: 1px solid #e2e8f0; color: #64748b; border-radius: 8px; width: 26px; height: 26px; cursor: pointer; flex: none; }
  .del:hover { color: #dc2626; border-color: #fecaca; background: #fef2f2; }
</style>
