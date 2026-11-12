# 0014. Hosting the transcription service on an on-demand GPU instance

Date: 2026-11-12
Status: accepted

## Context
The experimental Import option "Transcribe" (PR #5) turns a recording into a
score with MuScriptor (`ml/server.py`). It only ran on a developer's machine
(`npm run ml:serve`), so the deployed site could not use it. The model needs a
GPU to finish a 5-minute recording in minutes rather than an hour; App Runner
and Fargate have no GPUs, and App Runner throttles CPU between requests, which
rules out long background work there anyway.

Constraints: a student project's budget (the feature is used rarely, so an
always-on GPU at ~$385/month is out); the account's quotas (8 on-demand G-family
vCPUs, no spot GPU, one `ml.g5.xlarge` SageMaker endpoint); the service keeps job
state in memory and answers `/rebar` in seconds, so it wants to stay one
long-running process; the weights are gated on Hugging Face and licensed
CC BY-NC 4.0 (non-commercial).

Options weighed:
- **GPU instance, always on**: simplest, no cold start, ~$385/month.
- **GPU instance, started on demand, stops itself when idle**: ~$0.53/hour
  while used plus ~$6/month of disk; the first transcription after a quiet
  spell waits ~2 minutes for the boot.
- **SageMaker asynchronous inference, scaling to zero**: managed, ~$1.41/hour
  while running, but the service would have to fit SageMaker's container
  contract and `/rebar` would need hosting elsewhere.

## Decision
One `g4dn.xlarge` (NVIDIA T4) in the default VPC runs `ml/server.py` behind
uvicorn with TLS. The API starts the instance when a transcription (or a bar
rewrite) needs it, and the instance stops itself after 15 idle minutes
(`ml/deploy/idle-stop.sh`, with backstops at 45 minutes without an answering
service and 4 hours up). The API calls it over HTTPS on its public IP, pinned to
a self-signed certificate, with a bearer token; both live in SSM. Each deploy
uploads `ml/` to S3 and the instance installs the newest copy on every start.
`scripts/ml-init.sh` creates everything; `src/server/services/transcriber.ts`
is the client.

## Consequences
- The deployed site can transcribe. Cost follows use; idle cost is the disk.
- Cold start: ~2 minutes after an idle stop, ~10 minutes on a brand-new
  instance (PyTorch and the weights are installed then, and kept on its disk).
  A bar correction after a quiet spell waits for the boot too.
- Port 8333 is open to the internet because App Runner has no fixed egress IP;
  the token and TLS protect it. A VPC connector plus NAT would close it, at
  about $32/month (see infra/README "Known gaps").
- One instance means one transcription at a time (the service serializes
  model calls anyway); AWS can occasionally have no T4 capacity in the zone,
  which the job reports as "try again in a few minutes".
- Revisit when transcription leaves the experimental stage, gets regular use
  (always-on or SageMaker becomes cheaper per hour of waiting), or needs to be
  commercial (the CC BY-NC weights would have to go).
