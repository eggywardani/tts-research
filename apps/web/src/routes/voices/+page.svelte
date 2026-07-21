<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchSpeakers, createSpeaker, deleteSpeaker, type Speaker } from '$lib/api';

  let speakers = $state<Speaker[]>([]);
  let loading = $state(true);
  let error = $state('');

  // upload form
  let name = $state('');
  let language = $state('en');
  let refText = $state('');
  let file = $state<File | null>(null);
  let uploading = $state(false);
  let fileInput: HTMLInputElement | null = null;

  onMount(load);

  async function load() {
    loading = true;
    try {
      speakers = await fetchSpeakers();
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    } finally {
      loading = false;
    }
  }

  function onFile(e: Event) {
    file = (e.target as HTMLInputElement).files?.[0] ?? null;
    if (file && !name) name = file.name.replace(/\.[^.]+$/, '');
  }

  async function upload() {
    error = '';
    if (!name.trim()) return (error = 'Give the voice a name.'), undefined;
    if (!file) return (error = 'Choose an audio file.'), undefined;
    uploading = true;
    try {
      await createSpeaker({ name: name.trim(), language: language.trim() || 'en', refText, audio: file });
      name = '';
      refText = '';
      file = null;
      if (fileInput) fileInput.value = '';
      await load();
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    } finally {
      uploading = false;
    }
  }

  async function remove(s: Speaker) {
    if (!confirm(`Delete voice "${s.name}"?`)) return;
    try {
      await deleteSpeaker(s.id);
      speakers = speakers.filter((x) => x.id !== s.id);
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    }
  }
</script>

<main>
  <h1>Voice library</h1>
  <p class="sub">Upload reference clips once, then reuse them for cloning in the studio.</p>

  <section class="card upload">
    <div class="row">
      <label class="field grow"><span>Name</span><input bind:value={name} placeholder="e.g. Narrator" /></label>
      <label class="field lang"><span>Language</span><input bind:value={language} placeholder="en" /></label>
    </div>
    <label class="field"><span>Reference transcript (optional)</span><input bind:value={refText} placeholder="What the clip says…" /></label>
    <label class="field"><span>Audio file (wav / mp3 / flac / ogg)</span>
      <input type="file" accept="audio/*" bind:this={fileInput} onchange={onFile} />
    </label>
    <button class="go" onclick={upload} disabled={uploading}>{uploading ? 'Uploading…' : 'Upload voice'}</button>
    {#if error}<p class="error">{error}</p>{/if}
  </section>

  {#if loading}
    <p class="muted">Loading…</p>
  {:else if speakers.length === 0}
    <p class="muted">No saved voices yet.</p>
  {:else}
    <ul class="list">
      {#each speakers as s (s.id)}
        <li>
          <div class="info">
            <div class="name">{s.name} <span class="tag">{s.language}</span></div>
            <div class="file">{s.original_filename}</div>
          </div>
          {#if s.audio_url}<audio controls src={s.audio_url}></audio>{:else}<span class="muted small">no preview</span>{/if}
          <button class="del" onclick={() => remove(s)} aria-label="delete">✕</button>
        </li>
      {/each}
    </ul>
  {/if}
</main>

<style>
  main { width: 100%; }
  h1 { margin: 0 0 0.25rem; font-size: 1.35rem; letter-spacing: -0.02em; color: #111827; }
  .sub { margin: 0 0 1.25rem; color: #6b7280; font-size: 0.9rem; }
  .card { background: #fff; border: 1px solid #e6eaf1; border-radius: 14px; padding: 1.4rem; margin-bottom: 1.5rem; box-shadow: 0 1px 2px rgba(16,24,40,0.04); }
  .row { display: flex; gap: 0.75rem; }
  .field { display: flex; flex-direction: column; gap: 0.35rem; margin-bottom: 1rem; }
  .field.grow { flex: 1; }
  .field.lang { width: 6rem; }
  .field > span { font-size: 0.82rem; color: #475569; font-weight: 500; }
  input:not([type=file]) { background: #fff; border: 1px solid #d8dee9; border-radius: 9px; color: #1a1f36; padding: 0.55rem 0.7rem; font: inherit; width: 100%; box-sizing: border-box; }
  input:focus { outline: none; border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,0.12); }
  input[type='file'] { color: #6b7280; font: inherit; }
  .go { width: 100%; background: #2563eb; border: none; color: white; font-weight: 600; padding: 0.7rem; border-radius: 10px; cursor: pointer; }
  .go:hover { background: #1d4ed8; }
  .go:disabled { opacity: 0.6; }
  .error { color: #dc2626; font-size: 0.85rem; margin-top: 0.6rem; }
  .muted { color: #8a93a6; }
  .small { font-size: 0.78rem; }
  .list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.6rem; }
  .list li { display: grid; grid-template-columns: 1fr auto auto; align-items: center; gap: 0.75rem; background: #fff; border: 1px solid #e6eaf1; border-radius: 11px; padding: 0.7rem 0.9rem; box-shadow: 0 1px 2px rgba(16,24,40,0.03); }
  .info .name { font-weight: 600; color: #1a1f36; }
  .tag { font-size: 0.7rem; color: #4f566b; background: #eef1f6; padding: 0.1rem 0.45rem; border-radius: 999px; margin-left: 0.3rem; }
  .info .file { font-size: 0.75rem; color: #8a93a6; }
  .list audio { height: 34px; }
  .del { background: #fff; border: 1px solid #e2e8f0; color: #64748b; border-radius: 8px; width: 28px; height: 28px; cursor: pointer; }
  .del:hover { color: #dc2626; border-color: #fecaca; background: #fef2f2; }
</style>
