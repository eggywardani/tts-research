<script lang="ts">
  import { page } from '$app/stores';
  import type { Snippet } from 'svelte';

  let { children }: { children: Snippet } = $props();

  const nav = [
    { href: '/', label: 'Studio', crumb: 'Synthesis', icon: 'star' },
    { href: '/voices', label: 'Voice Library', crumb: 'Voice Models', icon: 'user' },
    { href: '/jobs', label: 'Job Monitor', crumb: 'Queue', icon: 'activity' },
    { href: '/history', label: 'History', crumb: 'Archives', icon: 'clock' },
    { href: '/tokens', label: 'API Tokens', crumb: 'Access', icon: 'key' },
  ] as const;

  let path = $derived($page.url.pathname);
  let bare = $derived(path === '/login');
  // Match sub-routes too (e.g. /history/<id> → History) so the header + active
  // nav stay correct on detail pages.
  const matches = (href: string, p: string) => p === href || (href !== '/' && p.startsWith(href + '/'));
  let current = $derived(nav.find((n) => matches(n.href, path)) ?? nav[0]);

  let sidebarOpen = $state(false);
</script>

<svelte:head><title>OmniVoice + RVC — TTS dashboard</title></svelte:head>

{#if bare}
  {@render children()}
{:else}
  <div class="app">
    {#if sidebarOpen}
      <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
      <div class="overlay" onclick={() => (sidebarOpen = false)}></div>
    {/if}

    <aside class="sidebar" class:open={sidebarOpen}>
      <a href="/" class="brand">
        <span class="logo">◆</span>
        <span class="brand-name">OmniVoice<span class="plus">+</span>RVC</span>
      </a>

      <nav class="side-nav">
        {#each nav as item}
          <a href={item.href} class="nav-link" class:active={matches(item.href, path)} onclick={() => (sidebarOpen = false)}>
            {#if item.icon === 'star'}
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.77 5.82 21 7 14.14l-5-4.87 6.91-1.01L12 2z"/></svg>
            {:else if item.icon === 'user'}
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="3.2"/><path d="M6 19v-.5A5.5 5.5 0 0111.5 13h1A5.5 5.5 0 0118 18.5V19"/></svg>
            {:else if item.icon === 'activity'}
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
            {:else if item.icon === 'key'}
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="15" r="4"/><path d="M10.85 12.15L19 4"/><path d="M18 5l2 2"/><path d="M15 8l2 2"/></svg>
            {:else}
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 8v4l3 2"/></svg>
            {/if}
            <span>{item.label}</span>
          </a>
        {/each}

        <!-- Served by the API (Scalar UI); opens standalone, so a plain new-tab link. -->
        <a href="/docs" class="nav-link" target="_blank" rel="noopener">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4a2 2 0 012-2h9l5 5v13a2 2 0 01-2 2H6a2 2 0 01-2-2V4z"/><path d="M14 2v6h6"/><path d="M9 13h6M9 17h4"/></svg>
          <span>API Docs</span>
          <svg class="ext" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17L17 7M9 7h8v8"/></svg>
        </a>
      </nav>

      <div class="side-footer">
        <div class="status"><span class="dot"></span> System online</div>
      </div>
    </aside>

    <main class="content">
      <header class="topbar">
        <div class="left">
          <button class="burger" onclick={() => (sidebarOpen = !sidebarOpen)} aria-label="Toggle sidebar">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12h18M3 6h18M3 18h18"/></svg>
          </button>
          <div>
            <h2>{current.label}</h2>
            <p class="crumb">Workspace / {current.crumb}</p>
          </div>
        </div>
        <form method="POST" action="/logout" class="logout-form">
          <button type="submit" class="logout" title="Sign out">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
            <span>Log out</span>
          </button>
        </form>
      </header>

      <div class="scroll">
        {@render children()}
      </div>
    </main>
  </div>
{/if}

<style>
  :global(*) { box-sizing: border-box; -webkit-font-smoothing: antialiased; }
  :global(body) {
    margin: 0;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #f4f6fb;
    color: #1a1f36;
  }
  :global(a) { color: inherit; }

  .app { display: flex; height: 100vh; width: 100vw; overflow: hidden; }

  .sidebar {
    width: 244px; min-width: 244px;
    background: #fff; border-right: 1px solid #e6eaf1;
    display: flex; flex-direction: column; padding: 1.25rem 0;
    z-index: 30;
  }
  .brand { display: flex; align-items: center; gap: 0.6rem; padding: 0 1.4rem; margin-bottom: 2rem; text-decoration: none; }
  .logo { color: #2563eb; font-size: 1.2rem; }
  .brand-name { font-weight: 700; font-size: 1.05rem; letter-spacing: -0.02em; color: #111827; }
  .plus { color: #2563eb; margin: 0 1px; }

  .side-nav { flex: 1; padding: 0 0.75rem; display: flex; flex-direction: column; gap: 0.2rem; }
  .nav-link {
    display: flex; align-items: center; gap: 0.7rem;
    padding: 0.6rem 0.85rem; border-radius: 9px;
    color: #4f566b; font-size: 0.92rem; font-weight: 500; text-decoration: none;
    transition: background 0.15s, color 0.15s;
  }
  .nav-link:hover { background: #f4f7fb; color: #1a1f36; }
  .nav-link.active { background: #eef4ff; color: #2563eb; }
  .nav-link svg { flex-shrink: 0; }
  .nav-link .ext { margin-left: auto; opacity: 0.45; }

  .side-footer { padding: 1rem 1.4rem 0; border-top: 1px solid #eef1f6; margin-top: 0.75rem; }
  .status { display: flex; align-items: center; gap: 0.5rem; font-size: 0.8rem; color: #697386; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #10b981; box-shadow: 0 0 0 3px rgba(16,185,129,0.15); }

  .content { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
  .topbar {
    height: 68px; flex-shrink: 0; background: #fff; border-bottom: 1px solid #e6eaf1;
    padding: 0 1.75rem; display: flex; align-items: center; justify-content: space-between;
  }
  .left { display: flex; align-items: center; gap: 0.75rem; }
  .burger { display: none; width: 36px; height: 36px; border: none; background: transparent; border-radius: 8px; color: #64748b; cursor: pointer; align-items: center; justify-content: center; }
  .burger:hover { background: #f1f5f9; }
  .topbar h2 { margin: 0; font-size: 1.15rem; font-weight: 700; color: #111827; }
  .crumb { margin: 0.1rem 0 0; font-size: 0.72rem; color: #8a93a6; text-transform: uppercase; letter-spacing: 0.05em; }

  .logout-form { margin: 0; }
  .logout {
    display: flex; align-items: center; gap: 0.45rem;
    background: #fff; border: 1px solid #e2e8f0; color: #475569;
    font-size: 0.82rem; font-weight: 500; padding: 0.45rem 0.8rem; border-radius: 9px; cursor: pointer;
    transition: all 0.15s;
  }
  .logout:hover { background: #fef2f2; border-color: #fecaca; color: #dc2626; }

  .scroll { flex: 1; overflow-y: auto; padding: 1.75rem; }

  .overlay { display: none; }

  @media (max-width: 820px) {
    .sidebar { position: fixed; top: 0; left: 0; height: 100vh; transform: translateX(-100%); transition: transform 0.22s ease; box-shadow: none; }
    .sidebar.open { transform: translateX(0); box-shadow: 4px 0 24px rgba(0,0,0,0.12); }
    .overlay { display: block; position: fixed; inset: 0; background: rgba(0,0,0,0.35); z-index: 20; }
    .burger { display: flex; }
    .scroll { padding: 1.1rem; }
    .topbar { padding: 0 1rem; }
    .logout span { display: none; }
  }
</style>
