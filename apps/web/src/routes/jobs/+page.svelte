<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { fetchJobs, cancelJob, type Job } from '$lib/api';

  let jobs = $state<Job[]>([]);
  let error = $state('');
  let loading = $state(true);
  let timer: ReturnType<typeof setInterval> | null = null;

  const ACTIVE = new Set(['queued', 'processing']);

  onMount(() => {
    load();
    timer = setInterval(load, 2000); // live-ish poll
  });
  onDestroy(() => timer && clearInterval(timer));

  async function load() {
    try {
      jobs = await fetchJobs(100);
      error = '';
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    } finally {
      loading = false;
    }
  }

  async function cancel(j: Job) {
    try {
      await cancelJob(j.id);
      await load();
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
  <h1>Job monitor</h1>
  <p class="sub">Generations are queued and processed by the worker pool. This list refreshes automatically.</p>

  {#if error}<p class="error">{error}</p>{/if}

  {#if loading}
    <p class="muted">Loading…</p>
  {:else if jobs.length === 0}
    <p class="muted">No jobs yet.</p>
  {:else}
    <ul class="list">
      {#each jobs as j (j.id)}
        <li>
          <div class="row1">
            <span class="badge {j.status}">{j.status}{#if j.status === 'queued'} · #{j.position}{/if}</span>
            <span class="text">{j.text || '(no text)'}</span>
            {#if ACTIVE.has(j.status)}
              <button class="cancel" onclick={() => cancel(j)}>Cancel</button>
            {/if}
          </div>
          <div class="row2">
            <span class="meta">{when(j.created_at)} · {j.engine}</span>
            {#if j.status === 'processing' && j.total_chunks > 0}
              <span class="prog"><span class="bar"><span class="fill" style="width:{(j.completed_chunks / j.total_chunks) * 100}%"></span></span>{j.completed_chunks}/{j.total_chunks}</span>
            {/if}
            {#if j.status === 'completed' && j.url}
              <audio controls src={j.url}></audio>
            {/if}
            {#if j.status === 'failed' && j.error}<span class="err">{j.error}</span>{/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</main>

<style>
  main { width: 100%; }
  h1 { margin: 0 0 0.25rem; font-size: 1.35rem; letter-spacing: -0.02em; color: #111827; }
  .sub { margin: 0 0 1.25rem; color: #6b7280; font-size: 0.9rem; }
  .error { color: #dc2626; font-size: 0.85rem; }
  .muted { color: #8a93a6; }
  .list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.6rem; }
  .list li { background: #fff; border: 1px solid #e6eaf1; border-radius: 11px; padding: 0.8rem 1rem; box-shadow: 0 1px 2px rgba(16,24,40,0.03); }
  .row1 { display: flex; align-items: center; gap: 0.75rem; }
  .text { flex: 1; font-size: 0.9rem; color: #1a1f36; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row2 { display: flex; align-items: center; gap: 0.9rem; margin-top: 0.5rem; }
  .meta { font-size: 0.74rem; color: #8a93a6; }
  .badge { font-size: 0.72rem; font-weight: 600; padding: 0.15rem 0.55rem; border-radius: 999px; text-transform: capitalize; }
  .badge.queued { background: #fef3c7; color: #b45309; }
  .badge.processing { background: #dbeafe; color: #1d4ed8; }
  .badge.completed { background: #dcfce7; color: #15803d; }
  .badge.failed { background: #fee2e2; color: #b91c1c; }
  .badge.cancelled { background: #f1f5f9; color: #64748b; }
  .prog { display: flex; align-items: center; gap: 0.5rem; font-size: 0.74rem; color: #6b7280; }
  .prog .bar { width: 120px; height: 6px; background: #e6eaf1; border-radius: 999px; overflow: hidden; }
  .prog .fill { display: block; height: 100%; background: #2563eb; }
  .row2 audio { height: 32px; }
  .err { font-size: 0.75rem; color: #b91c1c; }
  .cancel { background: #fff; border: 1px solid #fecaca; color: #dc2626; border-radius: 8px; padding: 0.35rem 0.7rem; cursor: pointer; font-size: 0.78rem; }
  .cancel:hover { background: #fef2f2; }
</style>
