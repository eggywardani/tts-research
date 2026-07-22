<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchSpeakers, createSpeaker, updateSpeaker, deleteSpeaker, type Speaker, type VoicePreset } from '$lib/api';
  import { decodeAudioFile, analyzeAudio, computePeaks, sliceToWav, type AudioAnalysis } from '$lib/audio';
  import WaveformTrimmer from '$lib/WaveformTrimmer.svelte';

  const MAX_MB = 50;
  const MIN_SEC = 3;
  const MAX_SEC = 30; // hard cap — longer references slow generation + hurt clone quality
  const REC_SEC = 10; // recommended clip length (OmniVoice works best on 3–10s)

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

  // pre-upload analysis + trim (client-side)
  let analyzing = $state(false);
  let analysis = $state<AudioAnalysis | null>(null);
  let peaks = $state<number[]>([]);
  let audioBuffer: AudioBuffer | null = null;
  let audioObjUrl = $state('');
  let trimStart = $state(0);
  let trimEnd = $state(0);
  let dragOver = $state(false);

  // per-voice settings editor
  let editId = $state<string | null>(null);
  let eName = $state('');
  let eLang = $state('en');
  let eRefText = $state('');
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

  function resetUpload() {
    file = null;
    analysis = null;
    peaks = [];
    audioBuffer = null;
    if (audioObjUrl) URL.revokeObjectURL(audioObjUrl);
    audioObjUrl = '';
    trimStart = 0;
    trimEnd = 0;
    if (fileInput) fileInput.value = '';
  }

  function onFilePick(e: Event) {
    const f = (e.target as HTMLInputElement).files?.[0] ?? null;
    if (f) void loadFile(f);
  }
  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragOver = false;
    const f = e.dataTransfer?.files?.[0] ?? null;
    if (f) void loadFile(f);
  }

  // Decode + analyze the file in the browser before any upload.
  async function loadFile(f: File) {
    error = '';
    if (f.size > MAX_MB * 1024 * 1024) {
      error = `File too large (max ${MAX_MB} MB).`;
      return;
    }
    analyzing = true;
    resetUpload();
    try {
      const buffer = await decodeAudioFile(f);
      if (buffer.duration < MIN_SEC) {
        error = `Clip too short (min ${MIN_SEC}s).`;
        analyzing = false;
        return;
      }
      audioBuffer = buffer;
      analysis = analyzeAudio(buffer);
      peaks = computePeaks(buffer, 240);
      audioObjUrl = URL.createObjectURL(f);
      trimStart = 0;
      // Default the selection to a short recommended window (~10s) so a good
      // reference is used even without manual trimming; user can adjust.
      trimEnd = Math.min(buffer.duration, REC_SEC);
      file = f;
      if (!name) name = f.name.replace(/\.[^.]+$/, '');
    } catch (e) {
      error = 'Could not read this audio file. Try WAV / MP3 / FLAC / OGG.';
    } finally {
      analyzing = false;
    }
  }

  async function upload() {
    error = '';
    if (!name.trim()) return (error = 'Give the voice a name.'), undefined;
    if (!file || !audioBuffer) return (error = 'Choose an audio file.'), undefined;
    const selLen = trimEnd - trimStart;
    if (selLen < MIN_SEC) return (error = `Select at least ${MIN_SEC}s.`), undefined;
    if (selLen > MAX_SEC) return (error = `Selection too long (max ${MAX_SEC}s) — trim it.`), undefined;

    uploading = true;
    try {
      // Trim to the selected region + normalize to a mono 16-bit WAV client-side.
      const wav = sliceToWav(audioBuffer, trimStart, trimEnd);
      const trimmed = new File([wav], `${name.trim() || 'voice'}.wav`, { type: 'audio/wav' });
      await createSpeaker({
        name: name.trim(),
        language: language.trim() || 'en',
        refText,
        audio: trimmed,
        preset: { temperature: 0.7, top_p: 0.9, cfg_scale: 2.0, seed: -1, use_rvc: false, rvc_model: '', rvc_pitch: 0 },
      });
      name = '';
      refText = '';
      resetUpload();
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
    const engine = s.default_engine || 'omnivoice';
    eRefText = s.engines?.[engine]?.ref_text ?? '';
  }

  async function saveEdit(id: string) {
    savingId = id;
    error = '';
    const preset: VoicePreset = {
      temperature: eTemp, top_p: eTopP, cfg_scale: eCfg, seed: eSeed,
      use_rvc: eUseRvc, rvc_model: eRvcModel, rvc_pitch: eRvcPitch,
    };
    const current = speakers.find((s) => s.id === id);
    const engine = current?.default_engine || 'omnivoice';
    // Persist the reference transcript into the engine config (what generation uses).
    const engines = {
      ...(current?.engines ?? {}),
      [engine]: { ...(current?.engines?.[engine] ?? {}), preset, ref_text: eRefText.trim() },
    };
    try {
      const updated = await updateSpeaker(id, {
        name: eName.trim() || 'Voice',
        language: eLang.trim() || 'en',
        voice_preset: preset,
        engines,
      });
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

  // ── Mini preview player (one at a time; audio only loads on play). ──
  let playingId = $state<string | null>(null);
  let paused = $state(true);
  let curTime = $state(0);
  let dur = $state(0);
  let playerEl: HTMLAudioElement | null = null;

  function togglePlay(s: Speaker) {
    if (!playerEl || !s.audio_url) return;
    if (playingId === s.id) {
      playerEl.paused ? playerEl.play() : playerEl.pause();
      return;
    }
    playerEl.src = s.audio_url; // fetched from S3 only now, on demand
    curTime = 0;
    dur = 0;
    playerEl.play().then(() => (playingId = s.id)).catch(() => {});
  }
  const fmt = (s: number) => {
    if (!isFinite(s) || s < 0) return '0:00';
    const m = Math.floor(s / 60);
    return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  };
</script>

<main>
  <h1>Voice library</h1>
  <p class="sub">Upload reference clips once, then reuse them for cloning in the studio. Each voice keeps its own generation settings.</p>

  <section class="card upload">
    <div class="row">
      <label class="field grow"><span>Name</span><input bind:value={name} placeholder="e.g. Narrator" /></label>
      <label class="field lang"><span>Language</span><input bind:value={language} placeholder="en" /></label>
    </div>
    <label class="field"><span>Reference transcript (optional — blank auto-transcribes)</span><input bind:value={refText} placeholder="Leave blank unless it EXACTLY matches the clip" /></label>

    <span class="field-label">Audio reference (source)</span>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="dropzone"
      class:over={dragOver}
      class:has={!!file}
      role="button"
      tabindex="0"
      onclick={() => fileInput?.click()}
      onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput?.click(); } }}
      ondragover={(e) => { e.preventDefault(); dragOver = true; }}
      ondragleave={() => (dragOver = false)}
      ondrop={onDrop}
    >
      <input type="file" accept="audio/*,.wav,.mp3,.flac,.ogg" bind:this={fileInput} onchange={onFilePick} hidden />
      <div class="dz-icon">⭱</div>
      {#if analyzing}
        <div class="dz-name">Analyzing…</div>
      {:else if file}
        <div class="dz-name">{file.name}</div>
        <button class="dz-clear" type="button" onclick={(e) => { e.stopPropagation(); resetUpload(); }}>Remove</button>
      {:else}
        <div class="dz-hint">Click or drop an audio file</div>
      {/if}
    </div>
    <p class="constraints">WAV, MP3, FLAC, OGG · {MIN_SEC}s min — {MAX_SEC}s max · {MAX_MB} MB limit · <b>Best: 3–10s clear speech</b></p>

    {#if analysis}
      <div class="analysis {analysis.score >= 85 ? 'good' : analysis.score >= 60 ? 'ok' : 'bad'}">
        <div class="an-head">
          <span class="an-title">Audio quality analysis</span>
          <span class="an-score">Score: {analysis.score}/100</span>
        </div>
        <div class="an-grid">
          <div class="an-item"><span>Duration</span><b>{analysis.duration.toFixed(2)}s</b></div>
          <div class="an-item"><span>Noise level</span><b>{analysis.noiseLabel} ({analysis.snrDb.toFixed(1)}dB)</b></div>
          <div class="an-item"><span>Optimization</span><b>{analysis.optimization}</b></div>
        </div>
        <p class="an-msg">💡 {analysis.message}</p>
      </div>

      <WaveformTrimmer {peaks} duration={audioBuffer?.duration ?? 0} bind:start={trimStart} bind:end={trimEnd} audioUrl={audioObjUrl} minGap={MIN_SEC} />
      {#if trimEnd - trimStart > 15}
        <p class="trim-warn">⚠ Long reference ({(trimEnd - trimStart).toFixed(0)}s). OmniVoice clones best on 3–10s — trim shorter for faster, cleaner results.</p>
      {/if}
    {/if}

    <button class="go" onclick={upload} disabled={uploading || !file}>{uploading ? 'Saving…' : 'Save to library'}</button>
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
            {#if s.audio_url}
              <button class="play-btn" class:playing={playingId === s.id && !paused} onclick={() => togglePlay(s)} aria-label="play">
                {playingId === s.id && !paused ? '❚❚' : '▶'}
              </button>
            {/if}
            <div class="info">
              <div class="name">{s.name} <span class="tag">{s.language}</span></div>
              <div class="file">{s.original_filename}</div>
            </div>
            {#if playingId === s.id}
              <div class="pwrap">
                <div class="pbar"><div class="pfill" style="width:{dur ? (curTime / dur) * 100 : 0}%"></div></div>
                <span class="ptime">{fmt(curTime)} / {fmt(dur)}</span>
              </div>
            {/if}
            <button class="edit" class:on={editId === s.id} onclick={() => toggleEdit(s)}>Settings</button>
            <button class="del" onclick={() => remove(s)} aria-label="delete">✕</button>
          </div>

          {#if editId === s.id}
            <div class="editor">
              <div class="row">
                <label class="field grow"><span>Name</span><input bind:value={eName} /></label>
                <label class="field lang"><span>Language</span><input bind:value={eLang} /></label>
              </div>

              <label class="field"><span>Reference transcript (blank = auto-transcribe; only fill if it EXACTLY matches the clip)</span>
                <input bind:value={eRefText} placeholder="e.g. Hello, this is a test of my voice." />
              </label>

              <div class="params">
                {@render param('temperature', eTemp, 0.1, 1.5, 0.05, (v) => (eTemp = v))}
                {@render param('top_p', eTopP, 0.1, 1, 0.05, (v) => (eTopP = v))}
                {@render param('cfg_scale', eCfg, 1, 5, 0.1, (v) => (eCfg = v))}
              </div>

              <div class="param seed">
                <div class="param-head">
                  <span>seed <em>{eSeed === -1 ? '· random' : ''}</em></span>
                  <input class="num" type="number" step="1" min="-1" bind:value={eSeed} />
                </div>
                <input class="slider" type="range" min="-1" max="100" step="1" value={eSeed} oninput={(e) => (eSeed = +e.currentTarget.value)} />
              </div>

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

<!-- one shared player: audio is fetched from S3 only when the user hits play -->
<audio
  bind:this={playerEl}
  preload="none"
  onplay={() => (paused = false)}
  onpause={() => (paused = true)}
  ontimeupdate={() => { if (playerEl) curTime = playerEl.currentTime; }}
  onloadedmetadata={() => { if (playerEl) dur = playerEl.duration || 0; }}
  onended={() => { playingId = null; paused = true; curTime = 0; }}
  hidden
></audio>

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
  .field-label { display: block; font-size: 0.82rem; color: #475569; font-weight: 500; margin-bottom: 0.4rem; }
  input:not([type=file]):not([type=range]):not([type=checkbox]):not(.num) { background: #fff; border: 1px solid #d8dee9; border-radius: 9px; color: #1a1f36; padding: 0.55rem 0.7rem; font: inherit; width: 100%; box-sizing: border-box; }

  .dropzone { border: 2px dashed #cddcff; background: #f5f8ff; border-radius: 12px; padding: 1.6rem 1rem; text-align: center; cursor: pointer; transition: background 0.15s, border-color 0.15s; }
  .dropzone:hover, .dropzone.over { background: #eef4ff; border-color: #2563eb; }
  .dropzone.has { border-style: solid; }
  .dz-icon { font-size: 1.5rem; color: #2563eb; line-height: 1; }
  .dz-hint { margin-top: 0.4rem; font-size: 0.85rem; color: #64748b; }
  .dz-name { margin-top: 0.4rem; font-size: 0.9rem; color: #2563eb; font-weight: 600; word-break: break-all; }
  .dz-clear { margin-top: 0.5rem; background: #fff; border: 1px solid #e2e8f0; color: #64748b; border-radius: 8px; padding: 0.25rem 0.7rem; cursor: pointer; font-size: 0.76rem; }
  .dz-clear:hover { color: #dc2626; border-color: #fecaca; }
  .constraints { margin: 0.5rem 0 1rem; font-size: 0.75rem; color: #8a93a6; }
  .constraints b { color: #475569; }
  .trim-warn { margin: 0.6rem 0 0; font-size: 0.78rem; color: #b45309; background: #fef7ec; border: 1px solid #f6dcae; border-radius: 8px; padding: 0.5rem 0.7rem; }

  .analysis { border: 1px solid #e6eaf1; border-radius: 12px; padding: 1rem 1.1rem; margin-bottom: 1rem; background: #f8fafc; }
  .analysis.good { background: #f0fbf4; border-color: #cceedd; }
  .analysis.bad { background: #fef5f5; border-color: #f6d5d5; }
  .an-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.7rem; }
  .an-title { font-size: 0.9rem; font-weight: 700; color: #1a1f36; }
  .an-score { font-size: 0.85rem; font-weight: 700; color: #15803d; }
  .analysis.bad .an-score { color: #b91c1c; }
  .an-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 0.5rem 1rem; }
  .an-item { display: flex; flex-direction: column; gap: 0.15rem; }
  .an-item span { font-size: 0.72rem; color: #8a93a6; text-transform: uppercase; letter-spacing: 0.03em; }
  .an-item b { font-size: 0.9rem; color: #1a1f36; }
  .an-msg { margin: 0.7rem 0 0; font-size: 0.82rem; color: #475569; }
  input:focus { outline: none; border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,0.12); }
  input[type='file'] { color: #6b7280; font: inherit; }
  .go { width: 100%; background: #2563eb; border: none; color: white; font-weight: 600; padding: 0.7rem; border-radius: 10px; cursor: pointer; }
  .go:hover { background: #1d4ed8; }
  .go:disabled { opacity: 0.6; }
  .error { color: #dc2626; font-size: 0.85rem; margin-top: 0.6rem; }
  .muted { color: #8a93a6; }
  .list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.6rem; }
  .list li { background: #fff; border: 1px solid #e6eaf1; border-radius: 11px; padding: 0.7rem 0.9rem; box-shadow: 0 1px 2px rgba(16,24,40,0.03); }
  .head { display: flex; align-items: center; gap: 0.85rem; }
  .info { flex: 1; min-width: 0; }
  .play-btn { flex: none; width: 38px; height: 38px; border-radius: 50%; border: none; background: #2563eb; color: #fff; font-size: 0.8rem; cursor: pointer; display: grid; place-items: center; line-height: 1; }
  .play-btn:hover { background: #1d4ed8; }
  .play-btn.playing { background: #1e40af; }
  .pwrap { display: flex; align-items: center; gap: 0.5rem; flex: none; }
  .pbar { width: 130px; height: 5px; background: #e6eaf1; border-radius: 999px; overflow: hidden; }
  .pfill { height: 100%; background: #2563eb; }
  .ptime { font-size: 0.72rem; color: #64748b; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .info .name { font-weight: 600; color: #1a1f36; }
  .tag { font-size: 0.7rem; color: #4f566b; background: #eef1f6; padding: 0.1rem 0.45rem; border-radius: 999px; margin-left: 0.3rem; }
  .info .file { font-size: 0.75rem; color: #8a93a6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .edit { background: #fff; border: 1px solid #e2e8f0; color: #475569; border-radius: 8px; padding: 0.35rem 0.7rem; cursor: pointer; font-size: 0.8rem; font-weight: 500; white-space: nowrap; }
  .edit:hover, .edit.on { background: #eef4ff; border-color: #cddcff; color: #2563eb; }
  .del { background: #fff; border: 1px solid #e2e8f0; color: #64748b; border-radius: 8px; width: 28px; height: 28px; cursor: pointer; }
  .del:hover { color: #dc2626; border-color: #fecaca; background: #fef2f2; }

  .editor { margin-top: 0.9rem; padding-top: 0.9rem; border-top: 1px solid #eef1f6; }
  .params { display: flex; flex-direction: column; gap: 0.9rem; margin-bottom: 1rem; }
  .param-head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; margin-bottom: 0.35rem; }
  .param-head span { font-size: 0.82rem; color: #475569; font-weight: 500; }
  .param-head span em { color: #9aa1af; font-style: normal; font-weight: 400; font-size: 0.72rem; }
  .param.seed { margin-bottom: 1rem; }
  .num { width: 4.5rem; flex: none; text-align: center; box-sizing: border-box; background: #fff; border: 1px solid #d8dee9; border-radius: 8px; color: #1a1f36; padding: 0.35rem 0.4rem; font: inherit; font-size: 0.82rem; }
  .slider { -webkit-appearance: none; appearance: none; width: 100%; height: 6px; background: #e2e8f0; border-radius: 999px; outline: none; cursor: pointer; }
  .slider::-webkit-slider-thumb { -webkit-appearance: none; width: 18px; height: 18px; background: #2563eb; border: 2px solid #fff; border-radius: 50%; cursor: pointer; box-shadow: 0 1px 3px rgba(16,24,40,0.25); }
  .slider::-moz-range-thumb { width: 18px; height: 18px; background: #2563eb; border: 2px solid #fff; border-radius: 50%; cursor: pointer; box-shadow: 0 1px 3px rgba(16,24,40,0.25); }
  .editor-actions { display: flex; justify-content: flex-end; gap: 0.6rem; margin-top: 1rem; }
  .cancel { background: #fff; border: 1px solid #e2e8f0; color: #475569; border-radius: 9px; padding: 0.5rem 1rem; cursor: pointer; font-size: 0.85rem; }
  .save { background: #2563eb; border: none; color: #fff; border-radius: 9px; padding: 0.5rem 1.1rem; cursor: pointer; font-size: 0.85rem; font-weight: 600; }
  .save:disabled { opacity: 0.6; }
</style>
