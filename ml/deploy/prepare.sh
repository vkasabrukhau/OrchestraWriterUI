#!/usr/bin/env bash
# Runs as root before every start of ov-transcriber.service (ExecStartPre=+):
#   1. the code the last deploy uploaded (s3://$BUCKET/system/transcriber/ml.tar.gz)
#   2. the token, Hugging Face token and TLS key + certificate from SSM
#   3. `uv sync` into /opt/ov-transcriber/venv, as user `transcriber`
set -euo pipefail
ROOT=/opt/ov-transcriber
set -a; . /etc/ov-transcriber.env; set +a
export AWS_DEFAULT_REGION="$AWS_REGION"

# 1. Code. Keep the copy from the last boot when S3 can't be reached.
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
if aws s3 cp --only-show-errors "s3://$BUCKET/system/transcriber/ml.tar.gz" "$tmp/ml.tar.gz"; then
  mkdir "$tmp/app"
  tar -xzf "$tmp/ml.tar.gz" -C "$tmp/app" --no-same-owner
  rm -rf "$ROOT/app.old"
  if [ -d "$ROOT/app" ]; then mv "$ROOT/app" "$ROOT/app.old"; fi
  mv "$tmp/app" "$ROOT/app"
  chmod -R a+rX,go-w "$ROOT/app"
  rm -rf "$ROOT/app.old"
  # Helper scripts ship with the code. Replace them by rename: this one is running.
  for f in prepare.sh run.sh idle-stop.sh; do
    install -m 755 "$ROOT/app/ml/deploy/$f" "$ROOT/bin/.$f.new"
    mv -f "$ROOT/bin/.$f.new" "$ROOT/bin/$f"
  done
else
  echo "could not download the code; starting the copy from the last boot" >&2
  [ -d "$ROOT/app/ml" ]
fi

# 2. Secrets.
param() {
  aws ssm get-parameter --name "$PARAM_PREFIX/$1" --with-decryption --query Parameter.Value --output text
}
install -d -m 700 -o transcriber -g transcriber "$ROOT/secrets"
(
  umask 077
  {
    printf 'TRANSCRIBER_TOKEN=%s\n' "$(param TRANSCRIBER_TOKEN)"
    printf 'HF_TOKEN=%s\n' "$(param HF_TOKEN)"
  } > "$ROOT/secrets/service.env"
  param TRANSCRIBER_TLS_KEY > "$ROOT/secrets/tls.key"
  param TRANSCRIBER_TLS_CERT > "$ROOT/secrets/tls.crt"
)
chown transcriber:transcriber "$ROOT/secrets"/*

# 3. Python packages, from the uv cache after the first boot.
cd "$ROOT/app/ml"
runuser -u transcriber -- /usr/local/bin/uv sync --frozen --python 3.11
