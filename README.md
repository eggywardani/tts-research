# tts-experience

A **minimal** TTS playground to experience the **OmniVoice + RVC** engine before
wiring it into [`audio-processor-llm`](../audio-processor-llm). Deliberately small
— same service shape as production (TTS + API + web + tunnel), none of the extra surface.

Stack: **Bun + Hono** (backend), **SvelteKit** (frontend), **Python/FastAPI**
running **OmniVoice** (zero-shot multilingual TTS) with an **RVC** post-processing
step (`rvc-python`, pass-through fallback when no model is present).

Features: voice **design** + voice **cloning**, long-text **chunking**, **SSE
streaming** with progressive chunk playback, and optional **RVC** re-timbring.

```
                    ┌───────────── GPU host (no inbound port) ─────────────┐
Browser ─▶ Cloudflare Tunnel ─▶ SvelteKit web (5173) ─/api,/health─▶ Bun+Hono API (9001) ─▶ FastAPI TTS (9000)
                    (public)      · password gate                     · x-api-token gate      └─ OmniVoice + RVC
                                  · proxies /api server-side          (private)               (private)
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Only the **web** is exposed publicly (one tunnel hostname → `web:5173`). The web
proxies `/api` + `/health` internally, so the **API and TTS stay private** — reachable
only from inside the host/compose network.

## Layout

| Path          | What                                                        |
| ------------- | ---------------------------------------------------------- |
| `apps/tts`    | Python TTS service — OmniVoice engine, RVC stub (GPU)       |
| `apps/api`    | Bun + Hono backend — thin proxy to the TTS service          |
| `apps/web`    | SvelteKit UI — text → speech, voice design / cloning, RVC   |
| `apps/tunnel` | Cloudflare Tunnel — exposes `web` publicly, no inbound port |

## Run

Three processes. The TTS service needs a **CUDA GPU** (OmniVoice); the API + web
run anywhere, including this Mac.

```bash
bun install

# 1) TTS service — on a GPU host (see apps/tts/README.md)
cd apps/tts && pip install -r requirements.txt && PORT=9000 python main.py

# 2) Backend API (point TTS_URL at the GPU host if remote)
bun run dev:api            # http://localhost:9001   TTS_URL=http://localhost:9000

# 3) Frontend
bun run dev:web            # http://localhost:5173
```

Or run API + web together: `bun run dev`.

If the TTS host is remote, start the API with its URL:

```bash
TTS_URL=https://your-gpu-box:9000 bun run dev:api
```

### Docker

`docker compose up --build` builds all services (the `tts` service needs an NVIDIA
GPU + nvidia-container-toolkit). The web runs as an `adapter-node` server and
proxies `/api` + `/health` to the API over the compose network, so it works the
same in prod as in dev. On a GPU-less machine, run only `api` + `web` and set
`TTS_URL` to a remote GPU host.

### Cloudflare Tunnel (GPU host)

A rented GPU box (vast.ai etc.) usually has **no public inbound port**, so it's
reached via a Cloudflare Tunnel — `cloudflared` dials *out* to Cloudflare; nothing
is port-forwarded. The `tunnel` service is already in the compose file.

1. Cloudflare **Zero Trust → Networks → Tunnels → Create a tunnel** (Cloudflared).
2. Copy the **Tunnel Token** → put it in the root `.env` as `TUNNEL_TOKEN=…`.
3. Add **one public hostname** route: e.g. `tts.example.com` → service
   `http://web:5173`. That's all — the web proxies `/api` + `/health` internally,
   so **don't** expose the API or TTS. (Add an `api.example.com → http://api:9001`
   route only if you need to call the backend directly from outside; it's still
   protected by `API_TOKEN`.)
4. `docker compose up --build`. The tunnel connects and your hostname goes live.

Keep the dashboard password (`AUTH_PASSWORD`) and `API_TOKEN` set when public.

## Access control

So not everyone can open the dashboard:

- **Dashboard password** — set `AUTH_PASSWORD` (comma-separated for multiple) in
  `apps/web/.env`. A SvelteKit hook (`hooks.server.ts`) redirects every route to
  `/login` until a valid password sets an HMAC cookie. Blank = gate disabled.
  Set a random `AUTH_SECRET` in production. There's a **Log out** button in the header.
- **Backend token** (defense-in-depth) — set the same `API_TOKEN` on **both** the
  API (`apps/api/.env`) and the web app (`apps/web/.env`). The API then rejects any
  `/api/*` call missing `x-api-token`; the web's server-side proxy (`hooks.server.ts`)
  injects it, so the token never reaches browser JS. This stops someone hitting
  `:9001` directly and bypassing the password. `/health` stays open. Blank = disabled.

Each app reads its **own** env file — copy the per-app examples:
`apps/api/.env.example`, `apps/web/.env.example`, `apps/tts/.env.example`. (The
root `.env.example` is only for `docker compose` variable substitution.) Both
gates are **off by default** (blank), so local dev stays frictionless until you opt in.

## Two ways to drive the voice

- **Voice design** — describe attributes: `female, low pitch, british accent`.
- **Voice cloning** — upload a 3–10s reference clip (transcript optional; OmniVoice
  auto-transcribes with Whisper).

Then optionally toggle **RVC** to re-timbre the result toward a trained target
voice. RVC is a **stub** right now (pass-through) — the toggle + model path are
wired end-to-end so you drop a real RVC lib into `apps/tts/rvc/converter.py`.

## Porting to audio-processor-llm

The engine interface (`apps/tts/engines/base.py`) mirrors production's, so a
working `OmniVoiceEngine` lifts over as another registered engine alongside
Chatterbox/Qwen3. The RVC step is the genuinely new piece to prove out here.
