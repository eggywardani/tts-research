<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { page } from '$app/stores';
  import { fetchHistory, fetchHistoryItem, deleteHistory, clearHistory, type HistoryItem } from '$lib/api';

  let items = $state<HistoryItem[]>([]);
  let loading = $state(true);
  let error = $state('');
  let expanded = $state<Set<string>>(new Set());
  let focusId = $state<string | null>(null);
  // Presigned URLs fetched lazily when a detail is opened (avoids S3 hits on list load).
  let audioUrls = $state<Record<string, string>>({});
  let loadingUrl = $state<Set<string>>(new Set());

  onMount(async () => {
    await load();
    // When arriving from the studio (?focus=<id>), open + scroll to that result.
    const focus = $page.url.searchParams.get('focus');
    const it = focus ? items.find((i) => i.id === focus) : undefined;
    if (it) {
      expanded = new Set([it.id]);
      ensureUrl(it);
      focusId = it.id;
      await tick();
      document.getElementById(`h-${it.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => (focusId = null), 2500); // fade the highlight
    }
  });

  // Load the presigned URL for a single record on demand (only when its detail
  // is opened). No-op if there's no archived audio or we already have it.
  async function ensureUrl(it: HistoryItem) {
    if (!it.has_audio || audioUrls[it.id] || loadingUrl.has(it.id)) return;
    loadingUrl = new Set(loadingUrl).add(it.id);
    try {
      const full = await fetchHistoryItem(it.id);
      if (full.url) audioUrls = { ...audioUrls, [it.id]: full.url };
    } catch {
      /* leave it unloaded; the card shows a retry hint */
    } finally {
      const next = new Set(loadingUrl);
      next.delete(it.id);
      loadingUrl = next;
    }
  }

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
    if (!confirm('Delete this recording?')) return;
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

  function toggle(it: HistoryItem) {
    const next = new Set(expanded);
    if (next.has(it.id)) {
      next.delete(it.id);
    } else {
      next.add(it.id);
      ensureUrl(it); // lazy-load audio only when opening the detail
    }
    expanded = next;
  }

  function when(iso: string): string {
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }
  const trunc = (t: string, n = 140) => (t.length > n ? t.slice(0, n) + '…' : t);
</script>

<main>
  <div class="head">
    <div>
      <h1>Audio history</h1>
      <p class="sub">Every generation is archived here. Open a result to load its audio + inspect its chunks (audio is fetched only when you open it).</p>
    </div>
    {#if items.length}<button class="clear" onclick={clearAll}>Clear all</button>{/if}
  </div>

  {#if error}<p class="error">{error}</p>{/if}

  {#if loading}
    <p class="muted">Loading…</p>
  {:else if items.length === 0}
    <p class="muted">Nothing generated yet.</p>
  {:else}
    <div class="grid">
      {#each items as it (it.id)}
        <div class="card" id={`h-${it.id}`} class:open={expanded.has(it.id)} class:focused={focusId === it.id}>
          <div class="body">
            <p class="text">“{trunc(it.text) || '(no text)'}”</p>
            <div class="tags">
              <span class="tag engine">{it.engine}</span>
              {#if it.rvc}<span class="tag">RVC</span>{/if}
              <span class="tag">{it.speaker_name ? it.speaker_name : 'voice design'}</span>
              {#if it.duration_seconds}<span class="tag">{it.duration_seconds.toFixed(1)}s</span>{/if}
              <span class="tag">{it.chunks?.length ?? 0} chunks</span>
              {#if !it.has_audio}<span class="tag muted-tag">no audio</span>{/if}
            </div>
          </div>

          {#if expanded.has(it.id)}
            <div class="detail">
              {#if it.has_audio}
                {#if audioUrls[it.id]}
                  <!-- preload="none": nothing fetched from S3 until the user hits play -->
                  <audio class="player" controls preload="none" src={audioUrls[it.id]}></audio>
                {:else if loadingUrl.has(it.id)}
                  <div class="noaudio">loading audio…</div>
                {:else}
                  <button class="link" onclick={() => ensureUrl(it)}>Load audio</button>
                {/if}
              {:else}
                <div class="noaudio">not archived (S3 off)</div>
              {/if}

              <div class="config">
                {#if it.params?.temperature != null}<div class="ci"><span>temperature</span><b>{it.params.temperature}</b></div>{/if}
                {#if it.params?.top_p != null}<div class="ci"><span>top_p</span><b>{it.params.top_p}</b></div>{/if}
                {#if it.params?.cfg_scale != null}<div class="ci"><span>cfg_scale</span><b>{it.params.cfg_scale}</b></div>{/if}
                {#if it.params?.seed != null}<div class="ci"><span>seed</span><b>{it.params.seed}</b></div>{/if}
                {#if it.sample_rate}<div class="ci"><span>sample rate</span><b>{it.sample_rate} Hz</b></div>{/if}
                {#if it.params?.rvc_model}<div class="ci"><span>rvc model</span><b>{it.params.rvc_model}</b></div>{/if}
              </div>

              {#if it.chunks?.length}
                <div class="chunks">
                  <div class="chunks-head">Chunks</div>
                  <ol>
                    {#each it.chunks as c (c.index)}
                      <li class={c.status}>
                        <span class="idx">{c.index + 1}</span>
                        <span class="ctext">{c.text || '—'}</span>
                        <span class="cstatus">{c.status}</span>
                      </li>
                    {/each}
                  </ol>
                </div>
              {/if}
            </div>
          {/if}

          <div class="footer">
            <span class="date">{when(it.created_at)}</span>
            <div class="actions">
              <button class="link" onclick={() => toggle(it)}>
                {expanded.has(it.id) ? 'Hide' : 'Details'}
              </button>
              <button class="del" onclick={() => remove(it)} aria-label="delete">✕</button>
            </div>
          </div>
        </div>
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

  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 1.25rem; }
  .card { background: #fff; border: 1px solid #e6eaf1; border-radius: 12px; display: flex; flex-direction: column; box-shadow: 0 1px 2px rgba(16,24,40,0.03); transition: border-color 0.15s, box-shadow 0.15s; }
  .card:hover { border-color: #cbd5e1; box-shadow: 0 2px 10px rgba(16,24,40,0.06); }
  .card.open { border-color: #cddcff; }
  .card.focused { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,0.25); animation: pulse 1.2s ease-out; }
  @keyframes pulse { 0% { box-shadow: 0 0 0 6px rgba(37,99,235,0.35); } 100% { box-shadow: 0 0 0 3px rgba(37,99,235,0.2); } }

  .body { padding: 1rem 1rem 0.75rem; }
  .text { margin: 0 0 0.7rem; font-size: 0.9rem; color: #1a1f36; line-height: 1.45; }
  .tags { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-bottom: 0.75rem; }
  .tag { font-size: 0.7rem; color: #4f566b; background: #eef1f6; border: 1px solid #e2e8f0; padding: 0.12rem 0.5rem; border-radius: 999px; }
  .tag.engine { background: #eef4ff; border-color: #cddcff; color: #2563eb; }
  .noaudio { font-size: 0.76rem; color: #a0a6b0; font-style: italic; padding: 0.4rem 0; }

  .detail { padding: 0 1rem 0.5rem; }
  .player { width: 100%; height: 36px; margin-bottom: 0.6rem; }
  .muted-tag { color: #a0a6b0; background: #f4f6fb; }
  .config { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 0.35rem 1rem; padding: 0.6rem 0; border-top: 1px solid #eef1f6; }
  .ci { display: flex; justify-content: space-between; font-size: 0.74rem; color: #6b7280; }
  .ci b { color: #1a1f36; font-weight: 600; }
  .chunks { margin-top: 0.5rem; border-top: 1px solid #eef1f6; padding-top: 0.6rem; }
  .chunks-head { font-size: 0.72rem; font-weight: 600; color: #475569; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 0.4rem; }
  .chunks ol { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.3rem; }
  .chunks li { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 0.5rem; font-size: 0.78rem; background: #fafbfd; border: 1px solid #eef1f6; border-radius: 7px; padding: 0.35rem 0.5rem; }
  .chunks li.failed { background: #fef2f2; border-color: #fecaca; }
  .chunks .idx { width: 1.3rem; height: 1.3rem; display: grid; place-items: center; background: #e6eaf1; border-radius: 999px; font-size: 0.68rem; color: #4f566b; }
  .chunks .ctext { color: #475569; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chunks .cstatus { font-size: 0.68rem; color: #8a93a6; text-transform: capitalize; }
  .chunks li.failed .cstatus { color: #dc2626; }

  .footer { display: flex; align-items: center; justify-content: space-between; padding: 0.6rem 1rem; border-top: 1px solid #eef1f6; margin-top: auto; }
  .date { font-size: 0.72rem; color: #8a93a6; }
  .actions { display: flex; align-items: center; gap: 0.5rem; }
  .link { background: none; border: none; color: #2563eb; font-size: 0.78rem; cursor: pointer; padding: 0.2rem 0.3rem; }
  .link:hover { text-decoration: underline; }
  .del { background: #fff; border: 1px solid #e2e8f0; color: #64748b; border-radius: 7px; width: 26px; height: 26px; cursor: pointer; }
  .del:hover { color: #dc2626; border-color: #fecaca; background: #fef2f2; }
</style>
