<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchSpeakers, createSpeaker, updateSpeaker, deleteSpeaker, type Speaker, type VoicePreset } from '$lib/api';

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

  // per-voice settings editor
  let editId = $state<string | null>(null);
  let eName = $state('');
  let eLang = $state('en');
  let eTemp = $state(0.7);
  let eTopP = $state(0.9);
  let eCfg = $state(2.0);
  let eSeed = $state(-1);
  let eUseRvc = $state(false);
  let eRvcModel = $state('');
  let eRvcPitch = $state(0);
  let savingId = $state<string | null>(null);

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
      await createSpeaker({
        name: name.trim(),
        language: language.trim() || 'en',
        refText,
        audio: file,
        // Seed the new voice with the default settings.
        preset: { temperature: 0.7, top_p: 0.9, cfg_scale: 2.0, seed: -1, use_rvc: false, rvc_model: '', rvc_pitch: 0 },
      });
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

  // Open (or close) the settings editor for a voice, loading its saved preset.
  function toggleEdit(s: Speaker) {
    if (editId === s.id) {
      editId = null;
      return;
    }
    const p = s.voice_preset ?? {};
    editId = s.id;
    eName = s.name;
    eLang = s.language;
    eTemp = p.temperature ?? 0.7;
    eTopP = p.top_p ?? 0.9;
    eCfg = p.cfg_scale ?? 2.0;
    eSeed = p.seed ?? -1;
    eUseRvc = p.use_rvc ?? false;
    eRvcModel = p.rvc_model ?? '';
    eRvcPitch = p.rvc_pitch ?? 0;
  }

  async function saveEdit(id: string) {
    savingId = id;
    error = '';
    const preset: VoicePreset = {
      temperature: eTemp, top_p: eTopP, cfg_scale: eCfg, seed: eSeed,
      use_rvc: eUseRvc, rvc_model: eRvcModel, rvc_pitch: eRvcPitch,
    };
    try {
      const updated = await updateSpeaker(id, { name: eName.trim() || 'Voice', language: eLang.trim() || 'en', voice_preset: preset });
      speakers = speakers.map((s) => (s.id === id ? updated : s));
      editId = null;
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    } finally {
      savingId = null;
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
  <p class="sub">Upload reference clips once, then reuse them for cloning in the studio. Each voice keeps its own generation settings.</p>

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
          <div class="head">
            <div class="info">
              <div class="name">{s.name} <span class="tag">{s.language}</span></div>
              <div class="file">{s.original_filename}</div>
            </div>
            {#if s.audio_url}<audio controls src={s.audio_url}></audio>{:else}<span class="muted small">no preview</span>{/if}
            <button class="edit" class:on={editId === s.id} onclick={() => toggleEdit(s)}>Settings</button>
            <button class="del" onclick={() => remove(s)} aria-label="delete">✕</button>
          </div>

          {#if editId === s.id}
            <div class="editor">
              <div class="row">
                <label class="field grow"><span>Name</span><input bind:value={eName} /></label>
                <label class="field lang"><span>Language</span><input bind:value={eLang} /></label>
              </div>

              <div class="params">
                {@render param('temperature', eTemp, 0.1, 1.5, 0.05, (v) => (eTemp = v))}
                {@render param('top_p', eTopP, 0.1, 1, 0.05, (v) => (eTopP = v))}
                {@render param('cfg_scale', eCfg, 1, 5, 0.1, (v) => (eCfg = v))}
              </div>

              <div class="param-head seed">
                <span>seed <em>(-1 = random)</em></span>
                <input class="num" type="number" step="1" min="-1" bind:value={eSeed} />
              </div>

              <label class="toggle"><input type="checkbox" bind:checked={eUseRvc} /> RVC post-processing</label>
              {#if eUseRvc}
                <div class="rvc-grid">
                  <label class="field"><span>rvc model (.pth)</span><input bind:value={eRvcModel} placeholder="my_voice.pth" /></label>
                  <label class="field"><span>rvc pitch</span><input type="number" step="1" bind:value={eRvcPitch} /></label>
                </div>
              {/if}

              <div class="editor-actions">
                <button class="cancel" onclick={() => (editId = null)}>Cancel</button>
                <button class="save" onclick={() => saveEdit(s.id)} disabled={savingId === s.id}>{savingId === s.id ? 'Saving…' : 'Save settings'}</button>
              </div>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</main>

{#snippet param(label: string, value: number, min: number, max: number, step: number, set: (v: number) => void)}
  <div class="param">
    <div class="param-head">
      <span>{label}</span>
      <input class="num" type="number" {min} {max} {step} value={value} oninput={(e) => set(+e.currentTarget.value)} />
    </div>
    <input class="slider" type="range" {min} {max} {step} value={value} oninput={(e) => set(+(+e.currentTarget.value).toFixed(2))} />
  </div>
{/snippet}

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
  input:not([type=file]):not([type=range]):not([type=checkbox]):not(.num) { background: #fff; border: 1px solid #d8dee9; border-radius: 9px; color: #1a1f36; padding: 0.55rem 0.7rem; font: inherit; width: 100%; box-sizing: border-box; }
  input:focus { outline: none; border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,0.12); }
  input[type='file'] { color: #6b7280; font: inherit; }
  .go { width: 100%; background: #2563eb; border: none; color: white; font-weight: 600; padding: 0.7rem; border-radius: 10px; cursor: pointer; }
  .go:hover { background: #1d4ed8; }
  .go:disabled { opacity: 0.6; }
  .error { color: #dc2626; font-size: 0.85rem; margin-top: 0.6rem; }
  .muted { color: #8a93a6; }
  .small { font-size: 0.78rem; }
  .list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.6rem; }
  .list li { background: #fff; border: 1px solid #e6eaf1; border-radius: 11px; padding: 0.7rem 0.9rem; box-shadow: 0 1px 2px rgba(16,24,40,0.03); }
  .head { display: grid; grid-template-columns: 1fr auto auto auto; align-items: center; gap: 0.75rem; }
  .info .name { font-weight: 600; color: #1a1f36; }
  .tag { font-size: 0.7rem; color: #4f566b; background: #eef1f6; padding: 0.1rem 0.45rem; border-radius: 999px; margin-left: 0.3rem; }
  .info .file { font-size: 0.75rem; color: #8a93a6; }
  .list audio { height: 34px; }
  .edit { background: #fff; border: 1px solid #e2e8f0; color: #475569; border-radius: 8px; padding: 0.35rem 0.7rem; cursor: pointer; font-size: 0.8rem; font-weight: 500; white-space: nowrap; }
  .edit:hover, .edit.on { background: #eef4ff; border-color: #cddcff; color: #2563eb; }
  .del { background: #fff; border: 1px solid #e2e8f0; color: #64748b; border-radius: 8px; width: 28px; height: 28px; cursor: pointer; }
  .del:hover { color: #dc2626; border-color: #fecaca; background: #fef2f2; }

  .editor { margin-top: 0.9rem; padding-top: 0.9rem; border-top: 1px solid #eef1f6; }
  .params { display: flex; flex-direction: column; gap: 0.9rem; margin-bottom: 1rem; }
  .param-head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; margin-bottom: 0.35rem; }
  .param-head span { font-size: 0.82rem; color: #475569; font-weight: 500; }
  .param-head span em { color: #9aa1af; font-style: normal; font-weight: 400; font-size: 0.72rem; }
  .param-head.seed { margin-bottom: 1rem; }
  .num { width: 4.5rem; flex: none; text-align: center; box-sizing: border-box; background: #fff; border: 1px solid #d8dee9; border-radius: 8px; color: #1a1f36; padding: 0.35rem 0.4rem; font: inherit; font-size: 0.82rem; }
  .slider { -webkit-appearance: none; appearance: none; width: 100%; height: 6px; background: #e2e8f0; border-radius: 999px; outline: none; cursor: pointer; }
  .slider::-webkit-slider-thumb { -webkit-appearance: none; width: 18px; height: 18px; background: #2563eb; border: 2px solid #fff; border-radius: 50%; cursor: pointer; box-shadow: 0 1px 3px rgba(16,24,40,0.25); }
  .slider::-moz-range-thumb { width: 18px; height: 18px; background: #2563eb; border: 2px solid #fff; border-radius: 50%; cursor: pointer; box-shadow: 0 1px 3px rgba(16,24,40,0.25); }
  .toggle { display: flex; align-items: center; gap: 0.5rem; font-size: 0.85rem; color: #475569; }
  .rvc-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; margin-top: 0.75rem; }
  .editor-actions { display: flex; justify-content: flex-end; gap: 0.6rem; margin-top: 1rem; }
  .cancel { background: #fff; border: 1px solid #e2e8f0; color: #475569; border-radius: 9px; padding: 0.5rem 1rem; cursor: pointer; font-size: 0.85rem; }
  .save { background: #2563eb; border: none; color: #fff; border-radius: 9px; padding: 0.5rem 1.1rem; cursor: pointer; font-size: 0.85rem; font-weight: 600; }
  .save:disabled { opacity: 0.6; }
</style>
