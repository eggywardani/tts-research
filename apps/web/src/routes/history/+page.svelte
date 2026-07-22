<script lang="ts">
  import { onMount } from 'svelte';
  import {
    fetchHistory,
    fetchHistoryFilters,
    deleteHistory,
    clearHistory,
    type HistoryItem,
    type HistoryFilterOptions,
  } from '$lib/api';

  let items = $state<HistoryItem[]>([]);
  let loading = $state(true);
  let error = $state('');

  // Filters
  let search = $state('');
  let speakerId = $state('');
  let engine = $state('');
  let fromDate = $state('');
  let toDate = $state('');
  let options = $state<HistoryFilterOptions>({ speakers: [], engines: [] });
  let searchTimer: ReturnType<typeof setTimeout> | undefined;

  const hasFilters = $derived(!!(search || speakerId || engine || fromDate || toDate));

  onMount(async () => {
    try {
      options = await fetchHistoryFilters();
    } catch {
      /* dropdowns just stay empty */
    }
    await load();
  });

  async function load() {
    loading = true;
    try {
      items = await fetchHistory({
        limit: 200,
        search: search.trim() || undefined,
        speaker_id: speakerId || undefined,
        engine: engine || undefined,
        from: fromDate || undefined,
        to: toDate || undefined,
      });
      error = '';
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    } finally {
      loading = false;
    }
  }

  // Debounce free-text search; selects/dates apply immediately.
  function onSearchInput() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(load, 300);
  }

  function reset() {
    search = '';
    speakerId = '';
    engine = '';
    fromDate = '';
    toDate = '';
    load();
  }

  async function remove(e: Event, it: HistoryItem) {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm('Delete this recording?')) return;
    try {
      await deleteHistory(it.id);
      items = items.filter((x) => x.id !== it.id);
    } catch (err) {
      error = String(err instanceof Error ? err.message : err);
    }
  }

  async function clearAll() {
    if (!confirm('Delete ALL history?')) return;
    try {
      await clearHistory();
      items = [];
      options = { speakers: [], engines: [] };
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
  const trunc = (t: string, n = 120) => (t.length > n ? t.slice(0, n) + '…' : t);
</script>

<main>
  <div class="head">
    <div>
      <h1>Audio history</h1>
      <p class="sub">Every generation is archived here. Click a card to open its detail (audio + chunks).</p>
    </div>
    {#if items.length}<button class="clear" onclick={clearAll}>Clear all</button>{/if}
  </div>

  <div class="filters">
    <input
      class="f-search"
      type="search"
      placeholder="Search text…"
      bind:value={search}
      oninput={onSearchInput}
    />
    <select class="f-sel" bind:value={speakerId} onchange={load} aria-label="Filter by voice">
      <option value="">All voices</option>
      {#each options.speakers as sp}<option value={sp.id}>{sp.name}</option>{/each}
    </select>
    <select class="f-sel" bind:value={engine} onchange={load} aria-label="Filter by engine">
      <option value="">All engines</option>
      {#each options.engines as e}<option value={e}>{e}</option>{/each}
    </select>
    <label class="f-date">From <input type="date" bind:value={fromDate} onchange={load} /></label>
    <label class="f-date">To <input type="date" bind:value={toDate} onchange={load} /></label>
    {#if hasFilters}<button class="f-reset" onclick={reset}>Reset</button>{/if}
  </div>

  {#if error}<p class="error">{error}</p>{/if}

  {#if loading}
    <p class="muted">Loading…</p>
  {:else if items.length === 0}
    <p class="muted">{hasFilters ? 'No results match these filters.' : 'Nothing generated yet.'}</p>
  {:else}
    <p class="count">{items.length} result{items.length === 1 ? '' : 's'}</p>

    <div class="grid">
      {#each items as it (it.id)}
        <a class="card" href="/history/{it.id}">
          <p class="text">“{trunc(it.text) || '(no text)'}”</p>
          <div class="tags">
            <span class="tag engine">{it.engine}</span>
            <span class="tag">{it.speaker_name ? it.speaker_name : 'voice design'}</span>
            {#if it.duration_seconds}<span class="tag">{it.duration_seconds.toFixed(1)}s</span>{/if}
            <span class="tag">{it.chunks?.length ?? 0} chunks</span>
          </div>
          <div class="foot">
            <span class="date">{when(it.created_at)}</span>
            <button class="del" onclick={(e) => remove(e, it)} aria-label="delete">✕</button>
          </div>
        </a>
      {/each}
    </div>
  {/if}
</main>

<style>
  main { width: 100%; }
  .head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: 1.25rem; }
  h1 { margin: 0 0 0.25rem; font-size: 1.35rem; letter-spacing: -0.02em; color: #111827; }
  .sub { margin: 0; color: #6b7280; font-size: 0.9rem; }
  .clear { background: #fff; border: 1px solid #fecaca; color: #dc2626; border-radius: 9px; padding: 0.4rem 0.8rem; cursor: pointer; font-size: 0.8rem; font-weight: 500; white-space: nowrap; flex: none; }
  .clear:hover { background: #fef2f2; }
  .error { color: #dc2626; font-size: 0.85rem; }
  .muted { color: #8a93a6; }

  .filters { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; margin-bottom: 1rem; }
  .filters input, .filters select { background: #fff; border: 1px solid #d8dee9; border-radius: 9px; color: #1a1f36; padding: 0.45rem 0.6rem; font: inherit; font-size: 0.85rem; }
  .filters input:focus, .filters select:focus { outline: none; border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,0.12); }
  .f-search { flex: 1; min-width: 180px; }
  .f-sel { cursor: pointer; }
  .f-date { display: flex; align-items: center; gap: 0.35rem; font-size: 0.78rem; color: #64748b; }
  .f-date input { padding: 0.35rem 0.5rem; }
  .f-reset { background: #fff; border: 1px solid #e2e8f0; color: #475569; border-radius: 9px; padding: 0.45rem 0.8rem; cursor: pointer; font-size: 0.82rem; }
  .f-reset:hover { background: #f8fafc; }
  .count { margin: 0 0 0.9rem; font-size: 0.78rem; color: #8a93a6; }

  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1.1rem; }
  .card { display: flex; flex-direction: column; background: #fff; border: 1px solid #e6eaf1; border-radius: 12px; padding: 1rem; box-shadow: 0 1px 2px rgba(16,24,40,0.03); text-decoration: none; color: inherit; transition: border-color 0.15s, box-shadow 0.15s; }
  .card:hover { border-color: #cddcff; box-shadow: 0 2px 10px rgba(16,24,40,0.06); }
  .text { margin: 0 0 0.7rem; font-size: 0.9rem; line-height: 1.45; color: #1a1f36; }
  .tags { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-bottom: 0.8rem; }
  .tag { font-size: 0.7rem; color: #4f566b; background: #eef1f6; border: 1px solid #e2e8f0; padding: 0.12rem 0.5rem; border-radius: 999px; }
  .tag.engine { background: #eef4ff; border-color: #cddcff; color: #2563eb; }
  .foot { display: flex; align-items: center; justify-content: space-between; margin-top: auto; padding-top: 0.6rem; border-top: 1px solid #eef1f6; }
  .date { font-size: 0.72rem; color: #8a93a6; }
  .del { background: #fff; border: 1px solid #e2e8f0; color: #64748b; border-radius: 7px; width: 26px; height: 26px; cursor: pointer; }
  .del:hover { color: #dc2626; border-color: #fecaca; background: #fef2f2; }
</style>
