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

### Deploy to vast.ai (native, no Docker)

A vast.ai instance is itself a container, so running our `docker compose` inside
it (docker-in-docker) is fiddly. Instead run the services **natively** on a
**PyTorch (Vast)** template (ships CUDA + PyTorch — OmniVoice's heaviest dep):

1. **Pick a GPU** — 16 GB VRAM is plenty for OmniVoice. Good picks from the search:
   RTX 5070 Ti 16 GB (~$0.13/hr) for cheapest, or RTX 5090 32 GB (~$0.30/hr) for
   headroom + faster download. (Blackwell cards need a recent torch — the PyTorch
   template has it; if OmniVoice misbehaves, try a 4090/3090.)
2. **Template:** PyTorch (Vast). **Disk:** bump container size to **~40 GB**
   (torch + model weights). No need to open ports if you use the tunnel.
3. **Rent**, then SSH in and:
   ```bash
   git clone https://github.com/eggywardani/tts-research.git
   cd tts-research
   AUTH_PASSWORD=yourpass API_TOKEN=sometoken TUNNEL_TOKEN=cf-token \
     bash scripts/vast-run.sh
   ```
   The script installs bun + python deps (keeps the template's torch), starts
   TTS + API + web, and — if `TUNNEL_TOKEN` is set — the Cloudflare Tunnel.
   First run downloads the OmniVoice model (watch `tail -f /tmp/tts.log`).
4. In Cloudflare, point one public hostname at `http://localhost:5173`
   (see below). No tunnel? Use vast's port mapping to reach `:5173`.

> Runs in **dev mode** (`bun run dev`, Vite proxies `/api`). For a hardened
> `adapter-node` build behind the tunnel, use the Docker path above instead.

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

### Per-client API tokens

For giving **each client its own token** (instead of the single shared `API_TOKEN`),
the dashboard has an **API Tokens** page (`/tokens`). Create/enable/disable/revoke
tokens there; each is stored in Postgres (`api_keys` table) and shown in full so it
can be re-copied. Two tiers:

- **Master token** = `API_TOKEN` → full admin, including token management. The web
  dashboard uses it via its server-side proxy.
- **Per-client token** (`tts_…`) → grants **every `/api/*` route except token
  management** (`/api/keys`). Clients send it directly to the API service as
  `Authorization: Bearer <token>`, an `x-api-token` header, or `?token=`:

  ```bash
  curl https://your-api-host:9001/api/speak \
    -H "Authorization: Bearer tts_xxdirect" \
    -F text="Hello" -F speaker_id=<uuid>
  ```

  Usage (`request_count`, `last_used_at`) is tracked per token. Set `API_TOKEN` to
  enable the gate; blank keeps it open for local dev. To let external clients reach
  the API directly, expose the API port/`:9001` (e.g. a second tunnel hostname
  `api.example.com → api:9001`) — the dashboard + TTS stay private.

### API docs

The API self-documents at **`GET /docs`** (a [Scalar](https://scalar.com) reference
UI) backed by **`GET /openapi.json`** (a hand-written OpenAPI 3.1 spec in
`apps/api/src/openapi.ts`). Both are **public** (no token) and served by the API
service — e.g. `http://your-api-host:9001/docs`. Keep the spec in sync by hand when
you add or change routes.

### Webhooks

`POST /api/tts/webhook` works like `/api/jobs` but requires a `webhook_url`. The
server POSTs status updates there as the job runs — `queued → processing →
progress → completed`/`failed` — instead of you polling or holding an SSE stream.
Delivery is best-effort: retried (1s/5s/15s, 30s timeout) and ordered per job, with
no signature, so treat the payload as advisory and re-verify via `GET /api/jobs/{id}`.
(Any job also accepts `webhook_url` — the dedicated route just enforces it.)

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
