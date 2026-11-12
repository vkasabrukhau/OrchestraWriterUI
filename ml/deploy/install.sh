#!/usr/bin/env bash
# One-time setup of the transcription service on its GPU instance. EC2 user-data
# runs it as root on the first boot (scripts/ml-init.sh launches the instance).
# Safe to re-run.
#
#   /opt/ov-transcriber/            owned by root
#     bin/prepare.sh                before every start: newest code from S3, secrets from SSM, uv sync
#     bin/run.sh                    the service itself (uvicorn, TLS), as user `transcriber`
#     bin/idle-stop.sh              every minute: stop the instance when idle (~$0.53/hr while running)
#     app/ml/                       the code: server.py, pyproject.toml, uv.lock, deploy/
#     secrets/                      token env file, TLS key and certificate (user `transcriber` only)
#     venv/ cache/ python/ hf/      Python env, uv cache, Python itself, model weights; kept across stops
#
# Needs BUCKET and AWS_REGION in the environment (user-data sets them).
set -euo pipefail
: "${BUCKET:?}" "${AWS_REGION:?}"
# EC2 user-data runs without HOME; the uv installer needs one.
export HOME=${HOME:-/root}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=/opt/ov-transcriber
# The uv that wrote ml/uv.lock; newer ones read it too.
UV_VERSION=0.7.8

# The idle check goes in first, so that if anything below fails the instance
# still stops itself (45 minutes without an answering service) instead of
# running up GPU hours.
install -d -m 755 -o root -g root "$ROOT" "$ROOT/bin"
for f in prepare.sh run.sh idle-stop.sh; do install -m 755 "$HERE/$f" "$ROOT/bin/$f"; done
install -m 644 "$HERE/ov-transcriber.service" "$HERE/ov-idle-stop.service" "$HERE/ov-idle-stop.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now ov-idle-stop.timer

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
# ffmpeg decodes the uploaded recordings (mp3 and friends).
apt-get install -y -q ffmpeg
command -v aws >/dev/null || apt-get install -y -q awscli
if ! /usr/local/bin/uv --version 2>/dev/null | grep -q " $UV_VERSION "; then
  curl -LsSf "https://astral.sh/uv/$UV_VERSION/install.sh" | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh
fi

id transcriber >/dev/null 2>&1 ||
  useradd --system --create-home --home-dir "$ROOT/home" --shell /usr/sbin/nologin transcriber
install -d -m 755 -o transcriber -g transcriber "$ROOT/venv" "$ROOT/cache" "$ROOT/python" "$ROOT/hf"

cat > /etc/ov-transcriber.env <<EOF
BUCKET=$BUCKET
AWS_REGION=$AWS_REGION
PARAM_PREFIX=${PARAM_PREFIX:-/orchestra-writer}
MUSCRIPTOR_MODEL=${MUSCRIPTOR_MODEL:-medium}
UV_CACHE_DIR=$ROOT/cache
UV_PYTHON_INSTALL_DIR=$ROOT/python
UV_PROJECT_ENVIRONMENT=$ROOT/venv
HF_HOME=$ROOT/hf
EOF

systemctl enable ov-transcriber.service
# The first start downloads Python, PyTorch and CUDA libraries (several minutes);
# later starts reuse them from venv/ and cache/.
systemctl restart --no-block ov-transcriber.service
echo "ov-transcriber installed"
