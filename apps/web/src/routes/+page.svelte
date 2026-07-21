<script lang="ts">
  import { onMount } from 'svelte';
  import {
    fetchHealth,
    fetchSpeakers,
    speak,
    speakStream,
    b64ToAudioUrl,
    type SpeakInput,
    type SpeakResult,
    type StreamEvent,
    type Speaker,
  } from '$lib/api';

  // Voice cloning is the default mode; the reference clip is chosen from the
  // saved Voice Library (upload/manage voices lives on the /voices page).
  let mode = $state<'clone' | 'design'>('clone');
  let text = $state('Hello — this is a test of the OmniVoice engine. It can speak long passages, split into chunks and streamed back as they render.');
  let refText = $state('');
  let instruct = $state('female, low pitch, british accent');

  // saved voices
  let speakers = $state<Speaker[]>([]);
  let selectedSpeakerId = $state('');

  // sampling
  let temperature = $state(0.7);
  let topP = $state(0.9);
  let cfgScale = $state(2.0);
  let seed = $state(-1);

  // rvc
  let useRvc = $state(false);
  let rvcModel = $state('');
  let rvcPitch = $state(0);

  // generation mode
  let stream = $state(true);

  // Settings come from the selected voice. In clone mode with no voice picked
  // (e.g. empty library), settings + generate are disabled.
  let settingsDisabled = $derived(mode === 'clone' && !selectedSpeakerId);

  let loading = $state(false);
  let error = $state('');
  let result = $state<SpeakResult | null>(null);
  let health = $state<any>(null);

  // streaming state
  let progress = $state({ done: 0, total: 0 });
  type Chunk = { index: number; text: string; url: string };
  let chunks = $state<Chunk[]>([]);
  let savedUrl = $state<string | null>(null);
  let playIdx = $state(-1);
  let audioEl: HTMLAudioElement | null = null;
  let playQueue: number[] = [];
  let isPlaying = false;

  onMount(async () => {
    try {
      health = await fetchHealth();
    } catch (e) {
      health = { status: 'unreachable', error: String(e) };
    }
    await loadSpeakers();
  });

  async function loadSpeakers() {
    try {
      speakers = await fetchSpeakers();
      // Default to the first saved voice so cloning works out of the box.
      if (!selectedSpeakerId && speakers.length > 0) {
        selectedSpeakerId = speakers[0].id;
        onPickSpeaker();
      }
    } catch {
      speakers = [];
    }
  }

  // When a saved voice is picked, pre-fill the sampling sliders from its preset.
  function onPickSpeaker() {
    const s = speakers.find((x) => x.id === selectedSpeakerId);
    if (!s) return;
    const p = s.voice_preset ?? {};
    if (p.temperature != null) temperature = p.temperature;
    if (p.top_p != null) topP = p.top_p;
    if (p.cfg_scale != null) cfgScale = p.cfg_scale;
    if (p.seed != null) seed = p.seed;
    if (p.use_rvc != null) useRvc = p.use_rvc;
    if (p.rvc_model != null) rvcModel = p.rvc_model;
    if (p.rvc_pitch != null) rvcPitch = p.rvc_pitch;
  }

  function reset() {
    error = '';
    result = null;
    savedUrl = null;
    chunks.forEach((c) => URL.revokeObjectURL(c.url));
    chunks = [];
    progress = { done: 0, total: 0 };
    playIdx = -1;
    playQueue = [];
    isPlaying = false;
  }

  function validate(): SpeakInput | null {
    if (!text.trim()) return (error = 'Enter some text.'), null;
    if (mode === 'clone' && !selectedSpeakerId) {
      return (error = 'Pick a voice from the library (add one in Voice Library).'), null;
    }
    if (mode === 'design' && !instruct.trim()) return (error = 'Describe the voice (e.g. "male, deep, calm").'), null;
    return {
      text, engine: 'omnivoice', mode, refText, instruct,
      temperature, topP, cfgScale, seed,
      useRvc, rvcModel, rvcPitch, speakerWav: null,
      speakerId: mode === 'clone' ? selectedSpeakerId || null : null,
    };
  }

  // Play chunks strictly in order as they arrive.
  function enqueue(index: number) {
    playQueue.push(index);
    playQueue.sort((a, b) => a - b);
    pump();
  }
  function pump() {
    if (isPlaying || !audioEl || playQueue.length === 0) return;
    const next = playQueue[0];
    const chunk = chunks.find((c) => c.index === next);
    if (!chunk) return;
    playQueue.shift();
    isPlaying = true;
    playIdx = next;
    audioEl.src = chunk.url;
    audioEl.play().catch(() => { isPlaying = false; });
  }
  function onEnded() {
    isPlaying = false;
    playIdx = -1;
    pump();
  }

  async function generate() {
    reset();
    const input = validate();
    if (!input) return;

    loading = true;
    try {
      if (stream) {
        await speakStream(input, (e: StreamEvent) => {
          if (e.type === 'start') progress = { done: 0, total: e.total };
          else if (e.type === 'chunk') {
            chunks = [...chunks, { index: e.index, text: e.text, url: b64ToAudioUrl(e.audio) }];
            progress = { done: chunks.length, total: e.total };
            enqueue(e.index);
          } else if (e.type === 'chunk_error') {
            progress = { ...progress, done: progress.done + 1 };
          } else if (e.type === 'saved') {
            savedUrl = e.url;
          } else if (e.type === 'error') {
            error = e.detail;
          }
        });
      } else {
        result = await speak(input);
      }
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    } finally {
      loading = false;
    }
  }
</script>

<audio bind:this={audioEl} onended={onEnded} hidden></audio>

<div class="studio-layout">
  <!-- LEFT: text + voice source + generate + results -->
  <div class="studio-main">
    <header class="page-head">
      <div>
        <p class="sub">TTS engine playground — experiment before wiring into audio-processor-llm</p>
      </div>
      {#if health}
        <div class="health {health?.tts?.status === 'ok' ? 'ok' : 'warn'}">
          api: ok · tts: {health?.tts?.status ?? '?'}
          {#if health?.tts?.device}· {health.tts.device}{/if}
          {#if health?.tts?.cuda === false}· <b>no GPU</b>{/if}
        </div>
      {/if}
    </header>

    <section class="card">
      <label class="field">
        <span>Text to speak</span>
        <textarea bind:value={text} rows="6" placeholder="Type what the voice should say…"></textarea>
      </label>

      <div class="tabs">
        <button class:active={mode === 'clone'} onclick={() => (mode = 'clone')}>Voice cloning</button>
        <button class:active={mode === 'design'} onclick={() => (mode = 'design')}>Voice design</button>
      </div>

      {#if mode === 'design'}
        <label class="field">
          <span>Describe the voice (instruct)</span>
          <input bind:value={instruct} placeholder="female, low pitch, british accent" />
        </label>
      {:else}
        {#if speakers.length > 0}
          <label class="field">
            <span>Voice (from library)</span>
            <select bind:value={selectedSpeakerId} onchange={onPickSpeaker}>
              {#each speakers as s}
                <option value={s.id}>{s.name} · {s.language}</option>
              {/each}
            </select>
          </label>

          <label class="field">
            <span>Reference transcript (optional — overrides the saved one)</span>
            <input bind:value={refText} placeholder="What the reference clip says…" />
          </label>
        {:else}
          <div class="empty-voices">
            No saved voices yet. Add a reference clip in the
            <a href="/voices">Voice Library</a> to clone from it.
          </div>
        {/if}
      {/if}

      <div class="action-bar">
        <label class="toggle"><input type="checkbox" bind:checked={stream} /> stream & play chunks progressively</label>
        <button class="go" onclick={generate} disabled={loading || settingsDisabled}>
          {loading ? 'Generating…' : 'Generate speech'}
        </button>
      </div>

      {#if error}<p class="error">{error}</p>{/if}

      {#if progress.total > 0}
        <div class="progress">
          <div class="bar"><div class="fill" style="width: {(progress.done / progress.total) * 100}%"></div></div>
          <span>{progress.done}/{progress.total} chunks</span>
        </div>
        <ol class="chunks">
          {#each chunks as c (c.index)}
            <li class:playing={playIdx === c.index}>
              <span class="idx">{c.index + 1}</span>
              <span class="ctext">{c.text}</span>
              <audio controls src={c.url}></audio>
            </li>
          {/each}
        </ol>
        {#if savedUrl}
          <div class="result">
            <div class="meta"><b>Saved to history.</b> <a href={savedUrl}>full recording</a></div>
          </div>
        {/if}
      {/if}

      {#if result}
        <div class="result">
          <audio controls src={result.audioUrl}></audio>
          <div class="meta">
            {result.sampleRate ? result.sampleRate + ' Hz · ' : ''}{result.engine}{result.rvc ? ' · RVC' : ''}
            <a href={result.audioUrl} download="omnivoice.wav">download</a>
          </div>
        </div>
      {/if}
    </section>
  </div>

  <!-- RIGHT: configuration (taken from the selected voice) -->
  <aside class="studio-side">
    <section class="card settings" class:disabled={settingsDisabled}>
      <h3>Settings</h3>

      {#if settingsDisabled}
        <p class="settings-hint">Select a voice to load its settings.</p>
      {/if}

      <div class="params">
        {@render param('temperature', temperature, 0.1, 1.5, 0.05, (v) => (temperature = v))}
        {@render param('top_p', topP, 0.1, 1, 0.05, (v) => (topP = v))}
        {@render param('cfg_scale', cfgScale, 1, 5, 0.1, (v) => (cfgScale = v))}
      </div>

      <div class="param seed-row">
        <div class="param-head">
          <span>seed <em>(-1 = random)</em></span>
          <input class="num" type="number" step="1" min="-1" bind:value={seed} disabled={settingsDisabled} />
        </div>
      </div>

      <div class="setting rvc">
        <label class="toggle"><input type="checkbox" bind:checked={useRvc} disabled={settingsDisabled} /> RVC post-processing</label>
        {#if useRvc}
          <div class="grid">
            <label>rvc model (.pth) <input bind:value={rvcModel} placeholder="my_voice.pth" disabled={settingsDisabled} /></label>
            <label>rvc pitch (semitones) <input type="number" step="1" bind:value={rvcPitch} disabled={settingsDisabled} /></label>
          </div>
        {/if}
      </div>
    </section>
  </aside>
</div>

{#snippet param(label: string, value: number, min: number, max: number, step: number, set: (v: number) => void)}
  <div class="param">
    <div class="param-head">
      <span>{label}</span>
      <input
        class="num"
        type="number"
        {min}
        {max}
        {step}
        value={value}
        oninput={(e) => set(+e.currentTarget.value)}
        disabled={settingsDisabled}
      />
    </div>
    <input
      class="slider"
      type="range"
      {min}
      {max}
      {step}
      value={value}
      oninput={(e) => set(+(+e.currentTarget.value).toFixed(2))}
      disabled={settingsDisabled}
    />
  </div>
{/snippet}

<style>
  .studio-layout { display: grid; grid-template-columns: 1fr 340px; gap: 1.5rem; align-items: start; }
  .studio-main { display: flex; flex-direction: column; gap: 1.25rem; min-width: 0; }
  .page-head { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  .sub { margin: 0; color: #6b7280; font-size: 0.9rem; }
  .settings { position: sticky; top: 0; }
  .settings.disabled { opacity: 0.55; }
  .settings h3 { margin: 0 0 1rem; font-size: 0.8rem; font-weight: 600; color: #475569; text-transform: uppercase; letter-spacing: 0.04em; }
  .settings-hint { margin: 0 0 1rem; font-size: 0.8rem; color: #8a93a6; }
  .setting { margin-bottom: 1.25rem; }
  .setting:last-child { margin-bottom: 0; }

  .params { display: flex; flex-direction: column; gap: 0.9rem; margin-bottom: 1rem; }
  .param-head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; margin-bottom: 0.35rem; }
  .param-head span { font-size: 0.82rem; color: #475569; font-weight: 500; }
  .param-head span em { color: #9aa1af; font-style: normal; font-weight: 400; font-size: 0.72rem; }
  .param .num { width: 4.5rem; text-align: center; padding: 0.35rem 0.4rem; font-size: 0.82rem; }
  .seed-row { margin-bottom: 1.25rem; }
  .slider { -webkit-appearance: none; appearance: none; width: 100%; height: 6px; background: #e2e8f0; border-radius: 999px; outline: none; cursor: pointer; }
  .slider::-webkit-slider-thumb { -webkit-appearance: none; width: 18px; height: 18px; background: #2563eb; border: 2px solid #fff; border-radius: 50%; cursor: pointer; box-shadow: 0 1px 3px rgba(16,24,40,0.25); }
  .slider::-moz-range-thumb { width: 18px; height: 18px; background: #2563eb; border: 2px solid #fff; border-radius: 50%; cursor: pointer; box-shadow: 0 1px 3px rgba(16,24,40,0.25); }
  .slider:disabled { cursor: not-allowed; }
  .slider:disabled::-webkit-slider-thumb { background: #9aa1af; }
  .action-bar { display: flex; align-items: center; gap: 1rem; margin-top: 0.5rem; }
  .action-bar .toggle { flex: 1; }
  .action-bar .go { width: auto; flex: none; padding: 0.7rem 1.5rem; }
  @media (max-width: 1024px) {
    .studio-layout { grid-template-columns: 1fr; }
    .settings { position: static; }
  }
  @media (max-width: 560px) {
    .action-bar { flex-direction: column; align-items: stretch; }
    .action-bar .go { width: 100%; }
  }
  .health { display: inline-block; font-size: 0.76rem; padding: 0.2rem 0.6rem; border-radius: 999px; background: #eef1f6; color: #697386; }
  .health.ok { color: #0f9d58; background: #e7f6ee; }
  .health.warn { color: #b7791f; background: #fdf4e3; }
  .card { background: #fff; border: 1px solid #e6eaf1; border-radius: 14px; padding: 1.4rem; box-shadow: 0 1px 2px rgba(16,24,40,0.04); }
  .field { display: flex; flex-direction: column; gap: 0.35rem; margin-bottom: 1rem; }
  .field > span { font-size: 0.82rem; color: #475569; font-weight: 500; }
  textarea, input:not([type]), input[type='number'], select {
    background: #fff; border: 1px solid #d8dee9; border-radius: 9px;
    color: #1a1f36; padding: 0.55rem 0.7rem; font: inherit; width: 100%; box-sizing: border-box;
  }
  textarea:focus, input:focus, select:focus { outline: none; border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,0.12); }
  textarea { resize: vertical; }
  .empty-voices { font-size: 0.85rem; color: #6b7280; background: #f8fafc; border: 1px dashed #d8dee9; border-radius: 9px; padding: 0.85rem 1rem; margin-bottom: 1rem; }
  .empty-voices a { color: #2563eb; font-weight: 500; }
  .tabs { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
  .tabs button { flex: 1; background: #f4f6fb; border: 1px solid #e2e8f0; color: #4f566b; padding: 0.5rem; border-radius: 9px; cursor: pointer; font: inherit; }
  .tabs button.active { background: #2563eb; border-color: #2563eb; color: #fff; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; }
  .grid label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.78rem; color: #6b7280; }
  .toggle { display: flex; align-items: center; gap: 0.5rem; font-size: 0.85rem; color: #475569; }
  .toggle input { width: auto; }
  .go { background: #2563eb; border: none; color: white; font-weight: 600; padding: 0.75rem; border-radius: 10px; cursor: pointer; font-size: 1rem; }
  .go:hover { background: #1d4ed8; }
  .go:disabled { opacity: 0.6; cursor: default; }
  .error { color: #dc2626; font-size: 0.85rem; margin-top: 0.75rem; }
  .progress { display: flex; align-items: center; gap: 0.6rem; margin-top: 1rem; font-size: 0.78rem; color: #6b7280; }
  .bar { flex: 1; height: 6px; background: #e6eaf1; border-radius: 999px; overflow: hidden; }
  .fill { height: 100%; background: #2563eb; transition: width 0.2s; }
  .chunks { list-style: none; padding: 0; margin: 0.75rem 0 0; display: flex; flex-direction: column; gap: 0.5rem; }
  .chunks li { display: grid; grid-template-columns: auto 1fr; gap: 0.4rem 0.6rem; align-items: center; background: #fafbfd; border: 1px solid #e6eaf1; border-radius: 9px; padding: 0.5rem 0.65rem; }
  .chunks li.playing { border-color: #2563eb; background: #f5f8ff; }
  .chunks .idx { grid-row: span 2; width: 1.4rem; height: 1.4rem; display: grid; place-items: center; background: #e6eaf1; border-radius: 999px; font-size: 0.72rem; color: #4f566b; }
  .chunks .ctext { font-size: 0.8rem; color: #475569; }
  .chunks audio { grid-column: 2; width: 100%; height: 32px; }
  .result { margin-top: 1.25rem; }
  .result audio { width: 100%; }
  .meta { margin-top: 0.4rem; font-size: 0.78rem; color: #6b7280; display: flex; gap: 0.75rem; }
  .meta a { color: #2563eb; }
</style>
