<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import {
    fetchHealth,
    fetchSpeakers,
    updateSpeaker,
    createJob,
    streamJob,
    pollJob,
    cancelJob,
    b64ToAudioUrl,
    type SpeakInput,
    type JobEvent,
    type Speaker,
  } from '$lib/api';

  // Voice cloning is the default mode; the reference clip is chosen from the
  // saved Voice Library (upload/manage voices lives on the /voices page).
  let mode = $state<'clone' | 'design'>('clone');
  let text = $state('Hello, this is a test of the OmniVoice engine. It can speak long passages, split them into chunks, and stream them back as they render.');
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

  // Settings come from the selected voice. In clone mode with no voice picked
  // (e.g. empty library), settings + generate are disabled.
  let settingsDisabled = $derived(mode === 'clone' && !selectedSpeakerId);

  let loading = $state(false);
  let error = $state('');
  let health = $state<any>(null);

  // job/queue state
  let jobId = $state<string | null>(null);
  let jobStatus = $state<string>('');
  let queuePos = $state(0);

  // streaming state
  let progress = $state({ done: 0, total: 0 });
  type Chunk = { index: number; text: string; url: string };
  let chunks = $state<Chunk[]>([]);
  let savedUrl = $state<string | null>(null);
  let playIdx = $state(-1);
  let audioEl: HTMLAudioElement | null = null;
  let playQueue: number[] = [];
  let isPlaying = false;

  // ── Persist studio inputs to localStorage so text + settings survive reloads
  // (no more re-pasting the script). Mirrors audio-processor-llm's tts_* keys. ──
  function lsGet<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : (JSON.parse(v) as T);
    } catch {
      return fallback;
    }
  }
  function lsSet(key: string, val: unknown) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch {
      /* storage full / unavailable — ignore */
    }
  }

  let restored = $state(false);

  onMount(async () => {
    // Restore before loading speakers so a saved voice selection is respected.
    text = lsGet('tts_text', text);
    mode = lsGet('tts_mode', mode);
    instruct = lsGet('tts_instruct', instruct);
    refText = lsGet('tts_refText', refText);
    selectedSpeakerId = lsGet('tts_speaker', '');
    temperature = lsGet('tts_temperature', temperature);
    topP = lsGet('tts_topP', topP);
    cfgScale = lsGet('tts_cfgScale', cfgScale);
    seed = lsGet('tts_seed', seed);
    useRvc = lsGet('tts_useRvc', useRvc);
    rvcModel = lsGet('tts_rvcModel', rvcModel);
    rvcPitch = lsGet('tts_rvcPitch', rvcPitch);
    restored = true;

    try {
      health = await fetchHealth();
    } catch (e) {
      health = { status: 'unreachable', error: String(e) };
    }
    await loadSpeakers();
  });

  // Save each field as it changes (only after the initial restore).
  $effect(() => { if (restored) lsSet('tts_text', text); });
  $effect(() => { if (restored) lsSet('tts_mode', mode); });
  $effect(() => { if (restored) lsSet('tts_instruct', instruct); });
  $effect(() => { if (restored) lsSet('tts_refText', refText); });
  $effect(() => { if (restored) lsSet('tts_speaker', selectedSpeakerId); });
  $effect(() => { if (restored) lsSet('tts_temperature', temperature); });
  $effect(() => { if (restored) lsSet('tts_topP', topP); });
  $effect(() => { if (restored) lsSet('tts_cfgScale', cfgScale); });
  $effect(() => { if (restored) lsSet('tts_seed', seed); });
  $effect(() => { if (restored) lsSet('tts_useRvc', useRvc); });
  $effect(() => { if (restored) lsSet('tts_rvcModel', rvcModel); });
  $effect(() => { if (restored) lsSet('tts_rvcPitch', rvcPitch); });

  async function loadSpeakers() {
    try {
      speakers = await fetchSpeakers();
      // Keep a restored voice if it still exists (preserves restored settings).
      // Otherwise fall back to the first voice + load its preset.
      const exists = selectedSpeakerId && speakers.some((s) => s.id === selectedSpeakerId);
      if (!exists) {
        selectedSpeakerId = '';
        if (speakers.length > 0) selectVoice(speakers[0]);
      }
    } catch {
      speakers = [];
    }
  }

  // Pick a saved voice: load its preset into the sliders + its saved reference
  // transcript (both come from the voice's own settings).
  function selectVoice(s: Speaker) {
    selectedSpeakerId = s.id;
    const p = s.voice_preset ?? {};
    if (p.temperature != null) temperature = p.temperature;
    if (p.top_p != null) topP = p.top_p;
    if (p.cfg_scale != null) cfgScale = p.cfg_scale;
    if (p.seed != null) seed = p.seed;
    if (p.use_rvc != null) useRvc = p.use_rvc;
    if (p.rvc_model != null) rvcModel = p.rvc_model;
    if (p.rvc_pitch != null) rvcPitch = p.rvc_pitch;
    const engine = s.default_engine || 'omnivoice';
    refText = s.engines?.[engine]?.ref_text ?? '';
  }

  // Persist the current experiment settings back to the selected voice's preset.
  let savingPreset = $state(false);
  let savedFlash = $state(false);

  async function savePreset() {
    const s = speakers.find((x) => x.id === selectedSpeakerId);
    if (!s) return;
    savingPreset = true;
    error = '';
    const preset = { temperature, top_p: topP, cfg_scale: cfgScale, seed, use_rvc: useRvc, rvc_model: rvcModel, rvc_pitch: rvcPitch };
    const engine = s.default_engine || 'omnivoice';
    const engines = { ...(s.engines ?? {}), [engine]: { ...(s.engines?.[engine] ?? {}), preset, ref_text: refText.trim() } };
    try {
      const updated = await updateSpeaker(s.id, { voice_preset: preset, engines });
      speakers = speakers.map((x) => (x.id === s.id ? updated : x));
      savedFlash = true;
      setTimeout(() => (savedFlash = false), 1800);
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    } finally {
      savingPreset = false;
    }
  }

  function resetPreset() {
    const s = speakers.find((x) => x.id === selectedSpeakerId);
    if (s) selectVoice(s); // reload sliders + ref text from the saved voice
  }

  function reset() {
    error = '';
    savedUrl = null;
    jobId = null;
    jobStatus = '';
    queuePos = 0;
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

  function onDone(status: string, url: string | null, historyId: string | null, detail?: string) {
    jobStatus = status;
    if (status === 'completed') {
      savedUrl = url;
      // Jump straight to the result detail page, like audio-processor-llm.
      goto(`/history/${historyId ?? jobId}`);
    } else if (status === 'cancelled') {
      error = 'Cancelled.';
    } else if (status === 'failed') {
      error = detail || 'generation failed';
    }
  }

  async function generate() {
    reset();
    const input = validate();
    if (!input) return;

    loading = true;
    let settled = false;
    try {
      const job = await createJob(input);
      jobId = job.id;
      jobStatus = job.status;
      queuePos = job.position;

      try {
        // Preferred path: live SSE (queue position → chunks → completed).
        await streamJob(job.id, (e: JobEvent) => {
          if (e.type === 'snapshot') {
            jobStatus = e.status;
            queuePos = e.position;
            if (e.total_chunks) progress = { done: e.completed_chunks, total: e.total_chunks };
          } else if (e.type === 'processing') {
            jobStatus = 'processing';
            queuePos = 0;
          } else if (e.type === 'start') {
            jobStatus = 'processing';
            progress = { done: 0, total: e.total };
          } else if (e.type === 'chunk') {
            chunks = [...chunks, { index: e.index, text: e.text, url: b64ToAudioUrl(e.audio) }];
            progress = { done: chunks.length, total: e.total };
            enqueue(e.index);
          } else if (e.type === 'completed') {
            settled = true;
            onDone('completed', e.url, e.history_id);
          } else if (e.type === 'cancelled') {
            settled = true;
            onDone('cancelled', null, null);
          } else if (e.type === 'error') {
            settled = true;
            onDone('failed', null, null, e.detail);
          }
        });
      } catch (sseErr) {
        // SSE dropped (common behind Cloudflare Tunnel). The job still runs in the
        // background — fall back to polling until it reaches a terminal state.
        if (!settled) {
          const final = await pollJob(job.id, (j) => {
            jobStatus = j.status;
            queuePos = j.position;
            if (j.total_chunks) progress = { done: j.completed_chunks, total: j.total_chunks };
          });
          onDone(final.status, final.url, final.history_id ?? final.id, final.error ?? undefined);
        }
      }
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    } finally {
      loading = false;
    }
  }

  async function cancel() {
    if (!jobId) return;
    try {
      await cancelJob(jobId);
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
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

      <div class="action-bar">
        {#if loading && (jobStatus === 'queued' || jobStatus === 'processing')}
          <span class="job-status">
            {#if jobStatus === 'queued'}⏳ Queued · position {queuePos}{:else}▶ Processing…{/if}
          </span>
          <button class="cancel" onclick={cancel}>Cancel</button>
        {/if}
        <button class="go" onclick={generate} disabled={loading || settingsDisabled}>
          {loading ? 'Working…' : 'Generate speech'}
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
    </section>
  </div>

  <!-- RIGHT: voice + configuration (taken from the selected voice) -->
  <aside class="studio-side">
    {#if mode === 'clone'}
      <section class="card voice-card">
        <h3>Voice</h3>
        {#if speakers.length > 0}
          <div class="voice-list">
            {#each speakers as s}
              <button class="voice-item" class:selected={selectedSpeakerId === s.id} onclick={() => selectVoice(s)}>
                <span class="v-icon">{s.name.slice(0, 1).toUpperCase()}</span>
                <span class="v-name">{s.name}</span>
                <span class="v-lang">{s.language}</span>
              </button>
            {/each}
          </div>
          <label class="field ref">
            <span>Reference transcript <em>(leave blank to auto-transcribe)</em></span>
            <input bind:value={refText} placeholder="Blank = auto. Only fill if it EXACTLY matches the clip." />
          </label>
        {:else}
          <div class="empty-voices">
            No saved voices yet. Add a clip in the <a href="/voices">Voice Library</a>.
          </div>
        {/if}
      </section>
    {:else}
      <section class="card voice-card">
        <h3>Voice design</h3>
        <label class="field ref">
          <span>Describe the voice (instruct)</span>
          <input bind:value={instruct} placeholder="female, low pitch, british accent" />
        </label>
      </section>
    {/if}

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
          <span>seed <em>{seed === -1 ? '· random' : ''}</em></span>
          <input class="num" type="number" step="1" min="-1" bind:value={seed} disabled={settingsDisabled} />
        </div>
        <input class="slider" type="range" min="-1" max="100" step="1" value={seed} oninput={(e) => (seed = +e.currentTarget.value)} disabled={settingsDisabled} />
      </div>

      <div class="setting rvc">
        <label class="toggle"><input type="checkbox" bind:checked={useRvc} disabled={settingsDisabled} /> RVC post-processing</label>
        <p class="rvc-note">Optional voice-changer: converts the result to a pre-trained RVC model (.pth). Not needed for normal cloning — leave off unless you have a trained model.</p>
        {#if useRvc}
          <label class="field rvc-field"><span>rvc model (.pth)</span>
            <input bind:value={rvcModel} placeholder="my_voice.pth" disabled={settingsDisabled} />
          </label>
          <div class="param">
            <div class="param-head">
              <span>rvc pitch <em>semitones</em></span>
              <input class="num" type="number" step="1" min="-12" max="12" bind:value={rvcPitch} disabled={settingsDisabled} />
            </div>
            <input class="slider" type="range" min="-12" max="12" step="1" value={rvcPitch} oninput={(e) => (rvcPitch = +e.currentTarget.value)} disabled={settingsDisabled} />
          </div>
        {/if}
      </div>

      {#if mode === 'clone' && selectedSpeakerId}
        <div class="preset-actions">
          <button class="reset" onclick={resetPreset} disabled={savingPreset}>Reset</button>
          <button class="save-preset" onclick={savePreset} disabled={savingPreset}>
            {savingPreset ? 'Saving…' : savedFlash ? 'Saved ✓' : 'Save to voice'}
          </button>
        </div>
        <p class="preset-hint">Generation uses these values live. Save to store them on “{speakers.find((s) => s.id === selectedSpeakerId)?.name}”.</p>
      {/if}
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
  .studio-side { display: flex; flex-direction: column; gap: 1.25rem; }
  .settings.disabled { opacity: 0.55; }
  .settings h3, .voice-card h3 { margin: 0 0 1rem; font-size: 0.8rem; font-weight: 600; color: #475569; text-transform: uppercase; letter-spacing: 0.04em; }

  .voice-list { display: flex; flex-direction: column; gap: 0.4rem; max-height: 220px; overflow-y: auto; margin-bottom: 1rem; }
  .voice-item { display: flex; align-items: center; gap: 0.6rem; width: 100%; text-align: left; padding: 0.45rem 0.6rem; background: #fff; border: 1px solid #e2e8f0; border-radius: 9px; cursor: pointer; font: inherit; }
  .voice-item:hover { border-color: #cbd5e1; background: #f8fafc; }
  .voice-item.selected { border-color: #2563eb; background: #eef4ff; }
  .v-icon { width: 26px; height: 26px; flex: none; display: grid; place-items: center; background: #e6eaf1; color: #4f566b; border-radius: 7px; font-size: 0.72rem; font-weight: 700; }
  .voice-item.selected .v-icon { background: #2563eb; color: #fff; }
  .v-name { flex: 1; font-size: 0.86rem; font-weight: 500; color: #1a1f36; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .v-lang { flex: none; font-size: 0.68rem; color: #64748b; background: #eef1f6; padding: 0.1rem 0.4rem; border-radius: 999px; text-transform: uppercase; }
  .voice-card .ref { margin-bottom: 0; }
  .voice-card .ref > span { font-size: 0.8rem; color: #475569; font-weight: 500; }
  .voice-card .ref > span em { font-style: normal; font-weight: 400; color: #9aa1af; font-size: 0.72rem; }
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
  .action-bar { display: flex; align-items: center; gap: 0.75rem; margin-top: 0.5rem; }
  .job-status { flex: 1; font-size: 0.85rem; color: #475569; }
  .action-bar .cancel { background: #fff; border: 1px solid #fecaca; color: #dc2626; border-radius: 9px; padding: 0.5rem 0.9rem; cursor: pointer; font-size: 0.85rem; }
  .action-bar .cancel:hover { background: #fef2f2; }
  .action-bar .go { width: auto; margin-left: auto; flex: none; padding: 0.7rem 1.5rem; }
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
  textarea, input:not([type]), input[type='number'] {
    background: #fff; border: 1px solid #d8dee9; border-radius: 9px;
    color: #1a1f36; padding: 0.55rem 0.7rem; font: inherit; width: 100%; box-sizing: border-box;
  }
  textarea:focus, input:focus { outline: none; border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,0.12); }
  textarea { resize: vertical; }
  .empty-voices { font-size: 0.85rem; color: #6b7280; background: #f8fafc; border: 1px dashed #d8dee9; border-radius: 9px; padding: 0.85rem 1rem; margin-bottom: 1rem; }
  .empty-voices a { color: #2563eb; font-weight: 500; }
  .tabs { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
  .tabs button { flex: 1; background: #f4f6fb; border: 1px solid #e2e8f0; color: #4f566b; padding: 0.5rem; border-radius: 9px; cursor: pointer; font: inherit; }
  .tabs button.active { background: #2563eb; border-color: #2563eb; color: #fff; }
  .rvc-field { margin: 0.9rem 0; }
  .rvc-note { margin: 0.4rem 0 0; font-size: 0.74rem; line-height: 1.4; color: #8a93a6; }
  .preset-actions { display: flex; gap: 0.5rem; margin-top: 1.25rem; }
  .preset-actions .reset { flex: none; background: #fff; border: 1px solid #e2e8f0; color: #475569; border-radius: 9px; padding: 0.5rem 0.9rem; cursor: pointer; font-size: 0.85rem; }
  .preset-actions .reset:hover { background: #f8fafc; }
  .preset-actions .save-preset { flex: 1; background: #2563eb; border: none; color: #fff; border-radius: 9px; padding: 0.5rem 0.9rem; cursor: pointer; font-size: 0.85rem; font-weight: 600; }
  .preset-actions .save-preset:hover { background: #1d4ed8; }
  .preset-actions button:disabled { opacity: 0.6; cursor: default; }
  .preset-hint { margin: 0.55rem 0 0; font-size: 0.72rem; line-height: 1.4; color: #8a93a6; }
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
  .meta { margin-top: 0.4rem; font-size: 0.78rem; color: #6b7280; display: flex; gap: 0.75rem; }
  .meta a { color: #2563eb; }
</style>
