#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# One-command setup + run for a vast.ai "PyTorch (Vast)" instance.
# The template already ships CUDA + PyTorch, so we DON'T reinstall torch.
#
# Runs three services natively (dev mode — matches the Vite proxy config):
#   TTS (OmniVoice) :9000   ·   API (Bun+Hono) :9001   ·   web (SvelteKit) :5173
# Public access via Cloudflare Tunnel (optional; set TUNNEL_TOKEN).
#
# Usage (on the instance, from the repo root):
#   AUTH_PASSWORD=yourpass API_TOKEN=sometoken TUNNEL_TOKEN=cf-token bash scripts/vast-run.sh
#
# Secrets are read from the environment; all are optional (blank = gate off).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root

export AUTH_PASSWORD="${AUTH_PASSWORD:-}"
export AUTH_SECRET="${AUTH_SECRET:-}"
export API_TOKEN="${API_TOKEN:-}"
export TTS_URL="${TTS_URL:-http://localhost:9000}"
export API_URL="${API_URL:-http://localhost:9001}"
export TUNNEL_TOKEN="${TUNNEL_TOKEN:-}"

log(){ echo -e "\n\033[1;35m[vast-run]\033[0m $*"; }

# ── bun ──────────────────────────────────────────────────────────────────────
if ! command -v bun >/dev/null 2>&1; then
  log "installing bun..."
  curl -fsSL https://bun.sh/install | bash
fi
export PATH="$HOME/.bun/bin:$PATH"

# ── python deps (torch is already in the template — do NOT reinstall it) ──────
# NOTE: verify the OmniVoice package name for your setup. If `omnivoice` pulls a
# conflicting torch, install it with --no-deps and add its extras manually, or use:
#   pip install "git+https://github.com/k2-fsa/OmniVoice.git"
log "installing TTS python deps..."
pip install --no-cache-dir -r apps/tts/requirements.txt

# ── js deps ──────────────────────────────────────────────────────────────────
log "installing js deps..."
bun install

# ── cloudflared (optional) ───────────────────────────────────────────────────
if [ -n "$TUNNEL_TOKEN" ] && ! command -v cloudflared >/dev/null 2>&1; then
  log "installing cloudflared..."
  curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
    -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared
fi

# ── start TTS (first run downloads the OmniVoice model — can take minutes) ────
log "starting TTS on :9000 ..."
( cd apps/tts && PORT=9000 RVC_MODELS_DIR="${RVC_MODELS_DIR:-models/rvc}" python main.py ) \
  > /tmp/tts.log 2>&1 &
log "waiting for TTS /health (tail -f /tmp/tts.log to watch model download)..."
for _ in $(seq 1 120); do
  curl -sf http://localhost:9000/health >/dev/null 2>&1 && { log "TTS is up."; break; }
  sleep 3
done

# ── start API ────────────────────────────────────────────────────────────────
log "starting API on :9001 ..."
( cd apps/api && PORT=9001 TTS_URL="$TTS_URL" API_TOKEN="$API_TOKEN" bun run src/server.ts ) \
  > /tmp/api.log 2>&1 &

# ── start web (dev; Vite proxies /api + /health -> API) ──────────────────────
log "starting web on :5173 ..."
( cd apps/web && API_URL="$API_URL" API_TOKEN="$API_TOKEN" \
    AUTH_PASSWORD="$AUTH_PASSWORD" AUTH_SECRET="$AUTH_SECRET" \
    bun run dev --host 0.0.0.0 --port 5173 ) > /tmp/web.log 2>&1 &

# ── tunnel (optional) ────────────────────────────────────────────────────────
if [ -n "$TUNNEL_TOKEN" ]; then
  log "starting Cloudflare Tunnel ..."
  cloudflared tunnel --no-autoupdate run --token "$TUNNEL_TOKEN" > /tmp/tunnel.log 2>&1 &
  log "tunnel started — point a public hostname at http://localhost:5173 in Cloudflare."
else
  log "no TUNNEL_TOKEN set — skipping tunnel. Access via vast port-mapping on :5173."
fi

log "all services started. logs: /tmp/{tts,api,web,tunnel}.log"
log "Ctrl-C to stop. Tailing logs:"
tail -f /tmp/tts.log /tmp/api.log /tmp/web.log
