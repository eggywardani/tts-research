<script lang="ts">
  // Waveform with a draggable trim selection. start/end (seconds) are bindable.
  let {
    peaks = [],
    duration = 0,
    start = $bindable(0),
    end = $bindable(0),
    audioUrl = '',
    minGap = 3,
  }: {
    peaks?: number[];
    duration?: number;
    start?: number;
    end?: number;
    audioUrl?: string;
    minGap?: number;
  } = $props();

  let track: HTMLDivElement | null = null;
  let dragging: 'left' | 'right' | null = null;
  let audioEl: HTMLAudioElement | null = null;
  let playing = $state(false);

  const pct = (t: number) => (duration > 0 ? (t / duration) * 100 : 0);

  function fracFromX(clientX: number): number {
    if (!track) return 0;
    const r = track.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  }

  function onDown(which: 'left' | 'right', e: PointerEvent) {
    e.preventDefault();
    dragging = which;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }
  function onMove(e: PointerEvent) {
    if (!dragging) return;
    const t = fracFromX(e.clientX) * duration;
    if (dragging === 'left') start = Math.max(0, Math.min(t, end - minGap));
    else end = Math.min(duration, Math.max(t, start + minGap));
  }
  function onUp() {
    dragging = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  }

  // Play just the selected region.
  function togglePlay() {
    if (!audioEl) return;
    if (playing) {
      audioEl.pause();
      playing = false;
      return;
    }
    audioEl.currentTime = start;
    audioEl.play().then(() => (playing = true)).catch(() => {});
  }
  function onTimeUpdate() {
    if (audioEl && playing && audioEl.currentTime >= end) {
      audioEl.pause();
      playing = false;
    }
  }

  const inSel = (i: number) => {
    const t = (i / Math.max(1, peaks.length)) * duration;
    return t >= start && t <= end;
  };
</script>

<div class="trimmer">
  <div class="track" bind:this={track}>
    <div class="bars">
      {#each peaks as p, i}
        <div class="bar" class:sel={inSel(i)} style="height:{Math.max(2, p * 100)}%"></div>
      {/each}
    </div>

    <!-- dimmed regions outside the selection -->
    <div class="mask left" style="width:{pct(start)}%"></div>
    <div class="mask right" style="left:{pct(end)}%; width:{100 - pct(end)}%"></div>

    <!-- handles -->
    <div class="handle" style="left:{pct(start)}%" onpointerdown={(e) => onDown('left', e)}></div>
    <div class="handle" style="left:{pct(end)}%" onpointerdown={(e) => onDown('right', e)}></div>
  </div>

  <div class="row">
    <button class="play" onclick={togglePlay} type="button">
      {playing ? '⏸ Pause' : '▶ Play selection'}
    </button>
    <span class="sel-label">{(end - start).toFixed(1)}s selected · {start.toFixed(1)}s–{end.toFixed(1)}s</span>
  </div>

  {#if audioUrl}
    <audio bind:this={audioEl} src={audioUrl} ontimeupdate={onTimeUpdate} onended={() => (playing = false)} hidden></audio>
  {/if}
</div>

<style>
  .trimmer { user-select: none; }
  .track { position: relative; height: 96px; background: #fafbfd; border: 1px solid #e6eaf1; border-radius: 10px; overflow: hidden; }
  .bars { position: absolute; inset: 0; display: flex; align-items: center; gap: 1px; padding: 0 2px; }
  .bar { flex: 1; background: #cdd5e1; border-radius: 1px; min-width: 1px; }
  .bar.sel { background: #2563eb; }
  .mask { position: absolute; top: 0; bottom: 0; background: rgba(244, 246, 251, 0.72); pointer-events: none; }
  .mask.left { left: 0; }
  .handle { position: absolute; top: 0; bottom: 0; width: 10px; margin-left: -5px; cursor: ew-resize; background: #2563eb; opacity: 0.85; border-radius: 3px; }
  .handle::after { content: ''; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 2px; height: 40%; background: #fff; border-radius: 2px; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; margin-top: 0.6rem; }
  .play { background: #eef4ff; border: 1px solid #cddcff; color: #2563eb; border-radius: 9px; padding: 0.4rem 0.8rem; cursor: pointer; font-size: 0.82rem; font-weight: 500; }
  .play:hover { background: #e2ecff; }
  .sel-label { font-size: 0.8rem; color: #2563eb; font-weight: 500; }
</style>
