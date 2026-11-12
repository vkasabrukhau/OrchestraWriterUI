#!/usr/bin/env bash
# Packs what the GPU instance runs into one tarball (paths start with ml/).
# Used by scripts/ml-init.sh and .github/workflows/deploy.yml, which upload it
# to s3://<bucket>/system/transcriber/ml.tar.gz; the instance pulls it on start.
#
#   ml/deploy/package.sh out.tar.gz
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${1:?usage: ml/deploy/package.sh out.tar.gz}"
# COPYFILE_DISABLE: no macOS ._ files when this runs on a Mac.
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$1" \
  ml/server.py ml/pyproject.toml ml/uv.lock ml/deploy
