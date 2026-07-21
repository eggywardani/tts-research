# Cloudflare Tunnel — exposes the web service publicly without any inbound port.
# The GPU host (vast.ai etc.) usually has no public inbound; cloudflared dials
# OUT to Cloudflare, so nothing needs to be port-forwarded.
FROM cloudflare/cloudflared:latest

# TUNNEL_TOKEN is set via environment (compose / Dokploy). Routes (hostname ->
# service) are configured in the Cloudflare Zero Trust dashboard, not here.
# --no-autoupdate stops cloudflared from updating itself inside the container.
CMD ["tunnel", "--no-autoupdate", "run"]
