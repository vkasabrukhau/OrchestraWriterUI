#!/usr/bin/env bash
# Every minute (ov-idle-stop.timer), as root: stop this GPU instance when the
# transcription service has had no transcription running and no call from the
# app for IDLE_MINUTES (default 15). The API starts it again on demand.
#
# Two backstops so a broken service can't keep a GPU running:
#   - no answer from the service 45 minutes after boot (the first boot installs
#     PyTorch, which takes several minutes, not 45)
#   - up for 4 hours (the API gives up on a transcription after 3)
set -uo pipefail
IDLE_SECONDS=$(( ${IDLE_MINUTES:-15} * 60 ))
up=$(cut -d. -f1 /proc/uptime)

stop() {
  logger -t ov-idle-stop "stopping the instance: $1"
  /sbin/shutdown -h now "ov-idle-stop: $1"
  exit 0
}

[ "$up" -ge 14400 ] && stop "up for more than 4 hours"

if ! health=$(curl -sfk --max-time 5 https://127.0.0.1:8333/health); then
  [ "$up" -ge 2700 ] && stop "the service has not answered since boot, or stopped answering"
  exit 0
fi
read -r running idle < <(python3 -c '
import json, sys
h = json.load(sys.stdin)
print(int(h.get("running", 0)), int(h.get("idleSeconds", 0)))' <<<"$health")
if [ "$running" -eq 0 ] && [ "$idle" -ge "$IDLE_SECONDS" ]; then
  stop "idle for $((idle / 60)) minutes"
fi
