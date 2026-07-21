<script lang="ts">
  import { onMount } from 'svelte';
  import {
    fetchHealth,
    speak,
    speakStream,
    b64ToAudioUrl,
    type SpeakInput,
    type SpeakResult,
    type StreamEvent,
  } from '$lib/api';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  let mode = $state<'clone' | 'design'>('design');
  let text = $state('Hello — this is a test of the OmniVoice engine. It can speak long passages, split into chunks and streamed back as they render.');
  let refText = $state('');
  let instruct = $state('female, low pitch, british accent');
  let speakerWav = $state<File | null>(null);

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

  let loading = $state(false);
  let error = $state('');
  let result = $state<SpeakResult | null>(null);
  let health = $state<any>(null);

  // streaming state
  let progress = $state({ done: 0, total: 0 });
  type Chunk = { index: number; text: string; url: string };
  let chunks = $state<Chunk[]>([]);
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
  });

  function onFile(e: Event) {
    speakerWav = (e.target as HTMLInputElement).files?.[0] ?? null;
  }

  function reset() {
    error = '';
    result = null;
    chunks.forEach((c) => URL.revokeObjectURL(c.url));
    chunks = [];
    progress = { done: 0, total: 0 };
    playIdx = -1;
    playQueue = [];
    isPlaying = false;
  }

  function validate(): SpeakInput | null {
    if (!text.trim()) return (error = 'Enter some text.'), null;
    if (mode === 'clone' && !speakerWav) return (error = 'Upload a 3–10s reference clip.'), null;
    if (mode === 'design' && !instruct.trim()) return (error = 'Describe the voice (e.g. "male, deep, calm").'), null;
    return {
      text, engine: 'omnivoice', mode, refText, instruct,
      temperature, topP, cfgScale, seed,
      useRvc, rvcModel, rvcPitch, speakerWav,
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
    if (!chunk) return; // not arrived yet; will retry on next enqueue/ended
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

<main>
  <header>
    <div class="titlebar">
      <h1>OmniVoice <span class="plus">+</span> RVC</h1>
      {#if data.authEnabled}
        <form method="POST" action="/logout"><button class="logout" type="submit">Log out</button></form>
      {/if}
    </div>
    <p class="sub">TTS engine playground — experiment before wiring into audio-processor-llm</p>
    {#if health}
      <div class="health {health?.tts?.status === 'ok' ? 'ok' : 'warn'}">
        api: ok · tts: {health?.tts?.status ?? '?'}
        {#if health?.tts?.device}· device: {health.tts.device}{/if}
        {#if health?.tts?.cuda === false}· <b>no GPU</b>{/if}
      </div>
    {/if}
  </header>

  <section class="card">
    <label class="field">
      <span>Text to speak</span>
      <textarea bind:value={text} rows="3" placeholder="Type what the voice should say…"></textarea>
    </label>

    <div class="tabs">
      <button class:active={mode === 'design'} onclick={() => (mode = 'design')}>Voice design</button>
      <button class:active={mode === 'clone'} onclick={() => (mode = 'clone')}>Voice cloning</button>
    </div>

    {#if mode === 'design'}
      <label class="field">
        <span>Describe the voice (instruct)</span>
        <input bind:value={instruct} placeholder="female, low pitch, british accent" />
      </label>
    {:else}
      <label class="field">
        <span>Reference audio (3–10s)</span>
        <input type="file" accept="audio/*" onchange={onFile} />
      </label>
      <label class="field">
        <span>Reference transcript (optional — auto-ASR if blank)</span>
        <input bind:value={refText} placeholder="What the reference clip says…" />
      </label>
    {/if}

    <details class="adv">
      <summary>Sampling</summary>
      <div class="grid">
        <label>temperature <input type="number" step="0.05" min="0.1" max="1.5" bind:value={temperature} /></label>
        <label>top_p <input type="number" step="0.05" min="0.1" max="1" bind:value={topP} /></label>
        <label>cfg_scale <input type="number" step="0.1" min="1" max="5" bind:value={cfgScale} /></label>
        <label>seed (-1 = random) <input type="number" step="1" min="-1" bind:value={seed} /></label>
      </div>
    </details>

    <details class="adv">
      <summary>RVC post-processing {useRvc ? '· on' : ''}</summary>
      <label class="toggle"><input type="checkbox" bind:checked={useRvc} /> convert with RVC (falls back to pass-through if no model)</label>
      {#if useRvc}
        <div class="grid">
          <label>rvc model (.pth) <input bind:value={rvcModel} placeholder="my_voice.pth" /></label>
          <label>rvc pitch (semitones) <input type="number" step="1" bind:value={rvcPitch} /></label>
        </div>
      {/if}
    </details>

    <label class="toggle stream-toggle"><input type="checkbox" bind:checked={stream} /> stream & play chunks progressively</label>

    <button class="go" onclick={generate} disabled={loading}>
      {loading ? 'Generating…' : 'Generate speech'}
    </button>

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
</main>

<style>
  :global(body) {
    margin: 0;
    background: #0e0f13;
    color: #e7e8ea;
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }
  main { max-width: 640px; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; }
  header { margin-bottom: 1.5rem; }
  .titlebar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  .logout { background: #1a1c22; border: 1px solid #2a2d37; color: #a9abb3; font-size: 0.78rem; padding: 0.35rem 0.7rem; border-radius: 8px; cursor: pointer; }
  .logout:hover { color: #e7e8ea; border-color: #3a3d47; }
  h1 { margin: 0; font-size: 2rem; letter-spacing: -0.02em; }
  .plus { color: #7c5cff; }
  .sub { margin: 0.25rem 0 0.75rem; color: #9a9ca3; font-size: 0.9rem; }
  .health { display: inline-block; font-size: 0.78rem; padding: 0.2rem 0.55rem; border-radius: 999px; background: #1a1c22; color: #9a9ca3; }
  .health.ok { color: #7ee2a8; }
  .health.warn { color: #ffcf6b; }
  .card { background: #16181f; border: 1px solid #23262f; border-radius: 14px; padding: 1.25rem; }
  .field { display: flex; flex-direction: column; gap: 0.35rem; margin-bottom: 1rem; }
  .field > span { font-size: 0.82rem; color: #a9abb3; }
  textarea, input:not([type]), input[type='number'] {
    background: #0e0f13; border: 1px solid #2a2d37; border-radius: 8px;
    color: #e7e8ea; padding: 0.55rem 0.65rem; font: inherit; width: 100%; box-sizing: border-box;
  }
  textarea { resize: vertical; }
  .tabs { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
  .tabs button { flex: 1; background: #0e0f13; border: 1px solid #2a2d37; color: #a9abb3; padding: 0.5rem; border-radius: 8px; cursor: pointer; }
  .tabs button.active { background: #7c5cff; border-color: #7c5cff; color: white; }
  .adv { margin-bottom: 1rem; border: 1px solid #23262f; border-radius: 8px; padding: 0.6rem 0.8rem; }
  .adv summary { cursor: pointer; color: #a9abb3; font-size: 0.85rem; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; margin-top: 0.75rem; }
  .grid label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.78rem; color: #9a9ca3; }
  .toggle { display: flex; align-items: center; gap: 0.5rem; font-size: 0.85rem; }
  .toggle input { width: auto; }
  .stream-toggle { margin: 0 0 1rem; color: #a9abb3; }
  .go { width: 100%; background: #7c5cff; border: none; color: white; font-weight: 600; padding: 0.75rem; border-radius: 10px; cursor: pointer; font-size: 1rem; }
  .go:disabled { opacity: 0.6; cursor: default; }
  .error { color: #ff8a8a; font-size: 0.85rem; margin-top: 0.75rem; }
  .progress { display: flex; align-items: center; gap: 0.6rem; margin-top: 1rem; font-size: 0.78rem; color: #9a9ca3; }
  .bar { flex: 1; height: 6px; background: #23262f; border-radius: 999px; overflow: hidden; }
  .fill { height: 100%; background: #7c5cff; transition: width 0.2s; }
  .chunks { list-style: none; padding: 0; margin: 0.75rem 0 0; display: flex; flex-direction: column; gap: 0.5rem; }
  .chunks li { display: grid; grid-template-columns: auto 1fr; gap: 0.4rem 0.6rem; align-items: center; background: #0e0f13; border: 1px solid #23262f; border-radius: 8px; padding: 0.5rem 0.65rem; }
  .chunks li.playing { border-color: #7c5cff; }
  .chunks .idx { grid-row: span 2; width: 1.4rem; height: 1.4rem; display: grid; place-items: center; background: #23262f; border-radius: 999px; font-size: 0.72rem; color: #a9abb3; }
  .chunks .ctext { font-size: 0.8rem; color: #c7c9cf; }
  .chunks audio { grid-column: 2; width: 100%; height: 32px; }
  .result { margin-top: 1.25rem; }
  .result audio { width: 100%; }
  .meta { margin-top: 0.4rem; font-size: 0.78rem; color: #9a9ca3; display: flex; gap: 0.75rem; }
  .meta a { color: #7c5cff; }
</style>
