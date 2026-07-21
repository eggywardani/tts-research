<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { fetchHistoryItem, deleteHistory, type HistoryItem } from '$lib/api';

  let item = $state<HistoryItem | null>(null);
  let loading = $state(true);
  let error = $state('');

  const id = $page.params.id;

  onMount(async () => {
    try {
      item = await fetchHistoryItem(id);
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    } finally {
      loading = false;
    }
  });

  async function remove() {
    if (!confirm('Delete this recording?')) return;
    try {
      await deleteHistory(id);
      goto('/history');
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
  <a class="back" href="/history">← Back to history</a>

  {#if loading}
    <p class="muted">Loading…</p>
  {:else if error}
    <p class="error">{error}</p>
  {:else if item}
    <div class="detail-head">
      <h1>Generation detail</h1>
      <button class="del" onclick={remove}>Delete</button>
    </div>

    <section class="card">
      <p class="text">“{item.text || '(no text)'}”</p>
      <div class="tags">
        <span class="tag engine">{item.engine}</span>
        {#if item.rvc}<span class="tag">RVC</span>{/if}
        <span class="tag">{item.speaker_name ? item.speaker_name : 'voice design'}</span>
        {#if item.duration_seconds}<span class="tag">{item.duration_seconds.toFixed(1)}s</span>{/if}
        <span class="tag">{item.chunks?.length ?? 0} chunks</span>
        <span class="tag when">{when(item.created_at)}</span>
      </div>

      {#if item.has_audio && item.url}
        <audio class="player" controls preload="none" src={item.url}></audio>
      {:else}
        <div class="noaudio">not archived (S3 off)</div>
      {/if}
    </section>

    <section class="card">
      <h3>Settings</h3>
      <div class="config">
        {#if item.params?.mode}<div class="ci"><span>mode</span><b>{item.params.mode}</b></div>{/if}
        {#if item.params?.temperature != null}<div class="ci"><span>temperature</span><b>{item.params.temperature}</b></div>{/if}
        {#if item.params?.top_p != null}<div class="ci"><span>top_p</span><b>{item.params.top_p}</b></div>{/if}
        {#if item.params?.cfg_scale != null}<div class="ci"><span>cfg_scale</span><b>{item.params.cfg_scale}</b></div>{/if}
        {#if item.params?.seed != null}<div class="ci"><span>seed</span><b>{item.params.seed}</b></div>{/if}
        {#if item.sample_rate}<div class="ci"><span>sample rate</span><b>{item.sample_rate} Hz</b></div>{/if}
        {#if item.params?.rvc_model}<div class="ci"><span>rvc model</span><b>{item.params.rvc_model}</b></div>{/if}
        {#if item.params?.rvc_pitch}<div class="ci"><span>rvc pitch</span><b>{item.params.rvc_pitch}</b></div>{/if}
      </div>
    </section>

    {#if item.chunks?.length}
      <section class="card">
        <h3>Chunks ({item.chunks.length})</h3>
        <ol class="chunks">
          {#each item.chunks as c (c.index)}
            <li class={c.status}>
              <span class="idx">{c.index + 1}</span>
              <span class="ctext">{c.text || '—'}</span>
              <span class="cstatus">{c.status}</span>
            </li>
          {/each}
        </ol>
      </section>
    {/if}
  {/if}
</main>

<style>
  main { width: 100%; max-width: 820px; }
  .back { display: inline-block; margin-bottom: 1rem; font-size: 0.85rem; color: #2563eb; text-decoration: none; }
  .back:hover { text-decoration: underline; }
  .detail-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem; }
  h1 { margin: 0; font-size: 1.35rem; letter-spacing: -0.02em; color: #111827; }
  .del { background: #fff; border: 1px solid #fecaca; color: #dc2626; border-radius: 9px; padding: 0.45rem 0.9rem; cursor: pointer; font-size: 0.82rem; font-weight: 500; }
  .del:hover { background: #fef2f2; }
  .muted { color: #8a93a6; }
  .error { color: #dc2626; }
  .card { background: #fff; border: 1px solid #e6eaf1; border-radius: 12px; padding: 1.2rem 1.3rem; margin-bottom: 1.1rem; box-shadow: 0 1px 2px rgba(16,24,40,0.03); }
  .card h3 { margin: 0 0 0.9rem; font-size: 0.78rem; font-weight: 600; color: #475569; text-transform: uppercase; letter-spacing: 0.04em; }
  .text { margin: 0 0 0.9rem; font-size: 1rem; line-height: 1.5; color: #1a1f36; }
  .tags { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-bottom: 1rem; }
  .tag { font-size: 0.72rem; color: #4f566b; background: #eef1f6; border: 1px solid #e2e8f0; padding: 0.14rem 0.55rem; border-radius: 999px; }
  .tag.engine { background: #eef4ff; border-color: #cddcff; color: #2563eb; }
  .tag.when { color: #8a93a6; }
  .player { width: 100%; height: 40px; }
  .noaudio { font-size: 0.8rem; color: #a0a6b0; font-style: italic; }
  .config { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 0.5rem 1.2rem; }
  .ci { display: flex; justify-content: space-between; font-size: 0.82rem; color: #6b7280; border-bottom: 1px solid #f1f4f9; padding-bottom: 0.35rem; }
  .ci b { color: #1a1f36; font-weight: 600; }
  .chunks { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.35rem; }
  .chunks li { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 0.6rem; font-size: 0.85rem; background: #fafbfd; border: 1px solid #eef1f6; border-radius: 8px; padding: 0.45rem 0.65rem; }
  .chunks li.failed { background: #fef2f2; border-color: #fecaca; }
  .chunks .idx { width: 1.5rem; height: 1.5rem; display: grid; place-items: center; background: #e6eaf1; border-radius: 999px; font-size: 0.72rem; color: #4f566b; }
  .chunks .ctext { color: #475569; }
  .chunks .cstatus { font-size: 0.72rem; color: #8a93a6; text-transform: capitalize; }
  .chunks li.failed .cstatus { color: #dc2626; }
</style>
