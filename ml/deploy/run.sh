#!/usr/bin/env bash
# The transcription service on the GPU instance: ml/server.py behind uvicorn,
# HTTPS on port 8333 with the self-signed certificate the API pins.
# Runs as user `transcriber` (ov-transcriber.service); prepare.sh ran first.
set -euo pipefail
ROOT=/opt/ov-transcriber
set -a; . /etc/ov-transcriber.env; . "$ROOT/secrets/service.env"; set +a
cd "$ROOT/app/ml"
exec /usr/local/bin/uv run --frozen --no-sync uvicorn server:app \
  --host 0.0.0.0 --port 8333 \
  --ssl-keyfile "$ROOT/secrets/tls.key" --ssl-certfile "$ROOT/secrets/tls.crt"
