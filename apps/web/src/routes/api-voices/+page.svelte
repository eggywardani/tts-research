<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchSpeakers, updateSpeaker, type Speaker } from '$lib/api';

  let speakers = $state<Speaker[]>([]);
  let loading = $state(true);
  let error = $state('');

  // Controls
  let langFilter = $state('');
  let sortBy = $state<'language' | 'name'>('language');

  // Inline edit state
  let editingName: string | null = $state(null);
  let editingLang: string | null = $state(null);
  let draft = $state('');
  let saving: string | null = $state(null);

  // Audio preview
  let audioEl: HTMLAudioElement | null = null;
  let playingId = $state<string | null>(null);

  onMount(load);

  async function load() {
    loading = true;
    try {
      speakers = await fetchSpeakers();
      error = '';
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    } finally {
      loading = false;
    }
  }

  const enabled = (s: Speaker) => s.api_enabled !== false;

  const stats = $derived({
    total: speakers.length,
    enabled: speakers.filter(enabled).length,
    hidden: speakers.filter((s) => !enabled(s)).length,
  });

  // Distinct languages with counts, for the filter dropdown.
  const languages = $derived.by(() => {
    const m = new Map<string, number>();
    for (const s of speakers) m.set(s.language, (m.get(s.language) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  });

  const visible = $derived.by(() => {
    let list = speakers.slice();
    if (langFilter) list = list.filter((s) => s.language === langFilter);
    list.sort((a, b) =>
      sortBy === 'name'
        ? a.name.localeCompare(b.name)
        : a.language.localeCompare(b.language) || a.name.localeCompare(b.name),
    );
    return list;
  });

  async function toggleApi(s: Speaker) {
    const next = !enabled(s);
    saving = s.id;
    try {
      await updateSpeaker(s.id, { api_enabled: next });
      s.api_enabled = next;
      speakers = speakers;
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    } finally {
      saving = null;
    }
  }

  function startRename(s: Speaker) {
    editingName = s.id;
    draft = s.name;
  }
  function startLang(s: Speaker) {
    editingLang = s.id;
    draft = s.language;
  }
  async function commit(s: Speaker, field: 'name' | 'language') {
    const value = draft.trim();
    editingName = editingLang = null;
    if (!value || value === (field === 'name' ? s.name : s.language)) return;
    saving = s.id;
    try {
      const updated = await updateSpeaker(s.id, { [field]: value });
      if (field === 'name') s.name = updated.name;
      else s.language = updated.language;
      speakers = speakers;
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    } finally {
      saving = null;
    }
  }
  function onKey(e: KeyboardEvent, s: Speaker, field: 'name' | 'language') {
    if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
    else if (e.key === 'Escape') {
      editingName = editingLang = null;
    }
  }

  function togglePlay(s: Speaker) {
    if (!audioEl || !s.audio_url) return;
    if (playingId === s.id) {
      audioEl.pause();
      playingId = null;
      return;
    }
    audioEl.src = s.audio_url;
    audioEl.play().then(() => (playingId = s.id)).catch(() => (playingId = null));
  }
</script>

<main>
  <div class="head">
    <div>
      <h1>API Voices</h1>
      <p class="sub">Control which voices are exposed to API clients. Toggle a voice off to hide it from the API without deleting it.</p>
    </div>
  </div>

  <div class="stats">
    <div class="stat"><span class="n">{stats.total}</span><span class="l">Total voices</span></div>
    <div class="stat on"><span class="n">{stats.enabled}</span><span class="l">API-enabled</span></div>
    <div class="stat off"><span class="n">{stats.hidden}</span><span class="l">Hidden</span></div>
  </div>

  {#if error}<p class="error">{error}</p>{/if}

  {#if loading}
    <p class="muted">Loading…</p>
  {:else if speakers.length === 0}
    <p class="muted">No voices yet. Add one in the <a href="/voices">Voice Library</a>.</p>
  {:else}
    <div class="controls">
      <select bind:value={langFilter} aria-label="Filter by language">
        <option value="">All languages ({speakers.length})</option>
        {#each languages as [lang, count]}<option value={lang}>{lang} ({count})</option>{/each}
      </select>
      <select bind:value={sortBy} aria-label="Sort by">
        <option value="language">Sort: Language</option>
        <option value="name">Sort: Name</option>
      </select>
    </div>

    <div class="list">
      {#each visible as s (s.id)}
        <div class="row" class:disabled={!enabled(s)}>
          <button class="play" onclick={() => togglePlay(s)} disabled={!s.audio_url} aria-label="Preview voice">
            {playingId === s.id ? '⏸' : '▶'}
          </button>

          <div class="info">
            <div class="name-row">
              {#if editingName === s.id}
                <!-- svelte-ignore a11y_autofocus -->
                <input
                  class="edit"
                  bind:value={draft}
                  autofocus
                  onblur={() => commit(s, 'name')}
                  onkeydown={(e) => onKey(e, s, 'name')}
                />
              {:else}
                <span class="name">{s.name}</span>
                <button class="pencil" onclick={() => startRename(s)} aria-label="Rename">✎</button>
              {/if}
              {#if s.is_default}<span class="badge builtin">built-in</span>{/if}
            </div>
            <div class="meta">
              {#if editingLang === s.id}
                <!-- svelte-ignore a11y_autofocus -->
                <input
                  class="edit lang-edit"
                  bind:value={draft}
                  autofocus
                  onblur={() => commit(s, 'language')}
                  onkeydown={(e) => onKey(e, s, 'language')}
                />
              {:else}
                <button class="lang" onclick={() => startLang(s)} title="Edit language">{s.language}</button>
              {/if}
              {#if s.duration_seconds}<span class="dur">{s.duration_seconds.toFixed(1)}s</span>{/if}
              <span class="fname">{s.original_filename}</span>
            </div>
          </div>

          <label class="switch" title={enabled(s) ? 'Exposed to API' : 'Hidden from API'}>
            <input type="checkbox" checked={enabled(s)} disabled={saving === s.id} onchange={() => toggleApi(s)} />
            <span class="track"><span class="thumb"></span></span>
          </label>
        </div>
      {/each}
    </div>
  {/if}

  <audio bind:this={audioEl} onended={() => (playingId = null)} hidden></audio>
</main>

<style>
  main { width: 100%; }
  .head { margin-bottom: 1.25rem; }
  h1 { margin: 0 0 0.25rem; font-size: 1.35rem; letter-spacing: -0.02em; color: #111827; }
  .sub { margin: 0; color: #6b7280; font-size: 0.9rem; max-width: 60ch; }
  .error { color: #dc2626; font-size: 0.85rem; }
  .muted { color: #8a93a6; }
  .muted a { color: #2563eb; }

  .stats { display: flex; gap: 1rem; margin-bottom: 1.5rem; flex-wrap: wrap; }
  .stat { display: flex; flex-direction: column; gap: 0.15rem; background: #fff; border: 1px solid #e6eaf1; border-radius: 12px; padding: 0.9rem 1.3rem; min-width: 130px; }
  .stat .n { font-size: 1.6rem; font-weight: 700; color: #111827; line-height: 1; }
  .stat .l { font-size: 0.76rem; color: #8a93a6; text-transform: uppercase; letter-spacing: 0.04em; }
  .stat.on .n { color: #15803d; }
  .stat.off .n { color: #94a3b8; }

  .controls { display: flex; gap: 0.5rem; margin-bottom: 1rem; flex-wrap: wrap; }
  .controls select { background: #fff; border: 1px solid #d8dee9; border-radius: 9px; color: #1a1f36; padding: 0.45rem 0.7rem; font: inherit; font-size: 0.85rem; cursor: pointer; }
  .controls select:focus { outline: none; border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,0.12); }

  .list { display: flex; flex-direction: column; gap: 0.6rem; }
  .row { display: flex; align-items: center; gap: 0.85rem; background: #fff; border: 1px solid #e6eaf1; border-radius: 12px; padding: 0.8rem 1rem; transition: opacity 0.15s; }
  .row.disabled { opacity: 0.55; }

  .play { flex: none; width: 38px; height: 38px; border-radius: 50%; border: none; background: #eef4ff; color: #2563eb; font-size: 0.9rem; cursor: pointer; display: flex; align-items: center; justify-content: center; }
  .play:hover:not(:disabled) { background: #e2ecff; }
  .play:disabled { opacity: 0.4; cursor: not-allowed; }

  .info { flex: 1; min-width: 0; }
  .name-row { display: flex; align-items: center; gap: 0.5rem; }
  .name { font-weight: 600; color: #111827; }
  .pencil { border: none; background: transparent; color: #94a3b8; cursor: pointer; font-size: 0.8rem; padding: 0; opacity: 0; transition: opacity 0.15s; }
  .row:hover .pencil { opacity: 1; }
  .pencil:hover { color: #2563eb; }
  .badge.builtin { font-size: 0.64rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; padding: 0.1rem 0.45rem; border-radius: 999px; background: #f3e8ff; color: #7c3aed; }
  .meta { display: flex; align-items: center; gap: 0.55rem; margin-top: 0.2rem; font-size: 0.76rem; color: #8a93a6; }
  .lang { border: 1px solid #e2e8f0; background: #eef1f6; color: #4f566b; border-radius: 999px; padding: 0.05rem 0.5rem; font-size: 0.72rem; cursor: pointer; }
  .lang:hover { border-color: #cddcff; color: #2563eb; }
  .fname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .edit { border: 1px solid #2563eb; border-radius: 7px; padding: 0.2rem 0.45rem; font: inherit; font-size: 0.9rem; color: #1a1f36; box-shadow: 0 0 0 3px rgba(37,99,235,0.12); outline: none; }
  .lang-edit { width: 4rem; font-size: 0.8rem; }

  .switch { flex: none; position: relative; display: inline-flex; cursor: pointer; }
  .switch input { position: absolute; opacity: 0; width: 0; height: 0; }
  .track { width: 40px; height: 22px; background: #cbd5e1; border-radius: 999px; transition: background 0.15s; display: inline-block; }
  .thumb { position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; background: #fff; border-radius: 50%; transition: transform 0.15s; box-shadow: 0 1px 2px rgba(0,0,0,0.25); }
  .switch input:checked + .track { background: #2563eb; }
  .switch input:checked + .track .thumb { transform: translateX(18px); }
  .switch input:disabled + .track { opacity: 0.5; }
</style>
