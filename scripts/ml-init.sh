#!/usr/bin/env bash
# One-time AWS setup for the experimental transcription service (ml/server.py,
# MuScriptor) on a GPU instance that runs only while it is used. Idempotent:
# re-run it any time; it creates what is missing and refreshes the rest.
#
# Creates (names derive from APP_NAME, default orchestra-writer):
#   SSM parameters   /orchestra-writer/TRANSCRIBER_TOKEN       bearer token between the API and the service (generated)
#                    /orchestra-writer/TRANSCRIBER_TLS_KEY     the service's TLS key (generated)
#                    /orchestra-writer/TRANSCRIBER_TLS_CERT    its self-signed certificate; the API pins it
#                    /orchestra-writer/HF_TOKEN                Hugging Face token for the gated model weights
#   S3 object        s3://<bucket>/system/transcriber/ml.tar.gz  the service code (deploy.yml refreshes it)
#   IAM role         orchestra-writer-transcriber (+ instance profile): read that object and those parameters,
#                    SSM agent (Session Manager for debugging; no SSH)
#   Security group   orchestra-writer-transcriber: TCP 8333 from anywhere (App Runner has no fixed egress IP;
#                    the service requires the token, over TLS)
#   EC2 instance     orchestra-writer-transcriber: g4dn.xlarge (NVIDIA T4), Deep Learning Base AMI (Ubuntu 22.04).
#                    It stops itself after 15 idle minutes (ml/deploy/idle-stop.sh) and the API starts it on demand.
# Extends:
#   orchestra-writer-apprunner-task   start that instance, describe instances
#   orchestra-writer-github-deploy    upload system/transcriber/* (deploy.yml ships the code)
#   App Runner service                TRANSCRIBER_INSTANCE_ID, TRANSCRIBER_TOKEN, TRANSCRIBER_TLS_CERT
#
# Needs: aws CLI as admin, openssl, and a Hugging Face token whose account accepted the
# model licence at https://huggingface.co/MuScriptor/muscriptor-medium: HF_TOKEN, or a
# `uvx hf auth login` on this machine. The weights are CC BY-NC 4.0: non-commercial use only.
#
# Options (env vars): UPLOAD_CODE=yes uploads this checkout's ml/ even when S3 already has a
# copy; INSTANCE_TYPE (default g4dn.xlarge).
set -euo pipefail
cd "$(dirname "$0")/.."

APP_NAME=${APP_NAME:-orchestra-writer}
AWS_REGION=${AWS_REGION:-us-east-1}
export AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION" AWS_PAGER=""
BUCKET=${S3_AUDIO_BUCKET:-orchestra-writer-s3}
NAME="$APP_NAME-transcriber"
INSTANCE_TYPE=${INSTANCE_TYPE:-g4dn.xlarge}
PARAMS="/$APP_NAME"
CODE_KEY="system/transcriber/ml.tar.gz"
AMI_PARAM=/aws/service/deeplearning/ami/x86_64/base-oss-nvidia-driver-gpu-ubuntu-22.04/latest/ami-id

log() { printf '\n==> %s\n' "$*"; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

log "Preflight"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
echo "account $ACCOUNT_ID, region $AWS_REGION, bucket $BUCKET, instance type $INSTANCE_TYPE"

# ------------------------------------------------------------------ SSM parameters
log "Parameters under $PARAMS/"
have_param() { aws ssm get-parameter --name "$PARAMS/$1" >/dev/null 2>&1; }
put_param() { # name type file
  aws ssm put-parameter --name "$PARAMS/$1" --type "$2" --value "file://$3" --overwrite >/dev/null
}
if have_param TRANSCRIBER_TOKEN; then echo "TRANSCRIBER_TOKEN exists"; else
  (umask 077; openssl rand -hex 32 | tr -d '\n' > "$TMP/token")
  put_param TRANSCRIBER_TOKEN SecureString "$TMP/token"
  echo "TRANSCRIBER_TOKEN generated"
fi
if have_param TRANSCRIBER_TLS_KEY && have_param TRANSCRIBER_TLS_CERT; then echo "TLS key and certificate exist"; else
  (umask 077; openssl ecparam -name prime256v1 -genkey -noout -out "$TMP/tls.key")
  # CA:TRUE so Node accepts the certificate as its own trust anchor (the API pins it).
  openssl req -new -x509 -key "$TMP/tls.key" -out "$TMP/tls.crt" -days 3650 -subj "/CN=$NAME" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "subjectAltName=DNS:$NAME"
  put_param TRANSCRIBER_TLS_KEY SecureString "$TMP/tls.key"
  put_param TRANSCRIBER_TLS_CERT String "$TMP/tls.crt"
  echo "TLS key and self-signed certificate generated (10 years)"
fi
HF=${HF_TOKEN:-$(cat "${HF_HOME:-$HOME/.cache/huggingface}/token" 2>/dev/null || true)}
if [ -n "$HF" ]; then
  (umask 077; printf '%s' "$HF" > "$TMP/hf")
  put_param HF_TOKEN SecureString "$TMP/hf"
  echo "HF_TOKEN stored"
elif have_param HF_TOKEN; then
  echo "HF_TOKEN exists"
else
  echo "ERROR: no Hugging Face token. Accept the licence at https://huggingface.co/MuScriptor/muscriptor-medium," >&2
  echo "       then set HF_TOKEN=hf_... or run 'uvx hf auth login', and re-run." >&2
  exit 1
fi

# ------------------------------------------------------------------ Code
log "Service code s3://$BUCKET/$CODE_KEY"
if [ "${UPLOAD_CODE:-}" = yes ] || ! aws s3api head-object --bucket "$BUCKET" --key "$CODE_KEY" >/dev/null 2>&1; then
  ml/deploy/package.sh "$TMP/ml.tar.gz"
  aws s3 cp --only-show-errors "$TMP/ml.tar.gz" "s3://$BUCKET/$CODE_KEY"
  echo "uploaded from this checkout"
else
  echo "exists (UPLOAD_CODE=yes replaces it with this checkout's ml/)"
fi

# ------------------------------------------------------------------ IAM
ROLE_CREATED=no
ensure_role() { # name trust-file
  if aws iam get-role --role-name "$1" >/dev/null 2>&1; then
    aws iam update-assume-role-policy --role-name "$1" --policy-document "file://$2"; echo "role $1 exists"
  else
    aws iam create-role --role-name "$1" --assume-role-policy-document "file://$2" >/dev/null; echo "role $1 created"; ROLE_CREATED=yes
  fi
}

log "Instance role and profile $NAME"
cat > "$TMP/ec2-trust.json" <<'JSON'
{ "Version": "2012-10-17", "Statement": [{ "Effect": "Allow", "Principal": { "Service": "ec2.amazonaws.com" }, "Action": "sts:AssumeRole" }] }
JSON
ensure_role "$NAME" "$TMP/ec2-trust.json"
aws iam attach-role-policy --role-name "$NAME" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
cat > "$TMP/instance-policy.json" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "Code", "Effect": "Allow", "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::$BUCKET/system/transcriber/*" },
    { "Sid": "Secrets", "Effect": "Allow", "Action": "ssm:GetParameter",
      "Resource": ["arn:aws:ssm:$AWS_REGION:$ACCOUNT_ID:parameter$PARAMS/TRANSCRIBER_*",
                   "arn:aws:ssm:$AWS_REGION:$ACCOUNT_ID:parameter$PARAMS/HF_TOKEN"] },
    { "Sid": "DecryptSecrets", "Effect": "Allow", "Action": "kms:Decrypt", "Resource": "*",
      "Condition": { "StringEquals": { "kms:ViaService": "ssm.$AWS_REGION.amazonaws.com" } } }
  ]
}
JSON
aws iam put-role-policy --role-name "$NAME" --policy-name transcriber --policy-document "file://$TMP/instance-policy.json"
if ! aws iam get-instance-profile --instance-profile-name "$NAME" >/dev/null 2>&1; then
  aws iam create-instance-profile --instance-profile-name "$NAME" >/dev/null
  aws iam add-role-to-instance-profile --instance-profile-name "$NAME" --role-name "$NAME"
  echo "instance profile created"; ROLE_CREATED=yes
else
  echo "instance profile exists"
fi

# ------------------------------------------------------------------ Network
log "Security group $NAME (default VPC)"
VPC=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
SG=$(aws ec2 describe-security-groups --filters "Name=group-name,Values=$NAME" "Name=vpc-id,Values=$VPC" \
  --query 'SecurityGroups[0].GroupId' --output text)
if [ "$SG" = None ]; then
  SG=$(aws ec2 create-security-group --group-name "$NAME" --vpc-id "$VPC" \
    --description "Orchestra Writer transcription service: HTTPS 8333, token required" --query GroupId --output text)
  aws ec2 authorize-security-group-ingress --group-id "$SG" --ip-permissions \
    'IpProtocol=tcp,FromPort=8333,ToPort=8333,IpRanges=[{CidrIp=0.0.0.0/0,Description="App Runner (no fixed egress IP)"}]' >/dev/null
  echo "created $SG"
else
  echo "exists $SG"
fi

# ------------------------------------------------------------------ Instance
log "GPU instance $NAME"
IID=$(aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=$NAME" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[].Instances[].InstanceId | [0]' --output text)
if [ "$IID" != None ]; then
  echo "exists $IID"
else
  AMI=$(aws ssm get-parameter --name "$AMI_PARAM" --query Parameter.Value --output text)
  cat > "$TMP/user-data.sh" <<EOF
#!/bin/bash
# First boot: fetch the service code and install it (ml/deploy/install.sh).
set -euxo pipefail
export BUCKET=$BUCKET AWS_REGION=$AWS_REGION AWS_DEFAULT_REGION=$AWS_REGION PARAM_PREFIX=$PARAMS
command -v aws >/dev/null || { apt-get update -q && apt-get install -y -q awscli; }
mkdir -p /root/ov-bootstrap
aws s3 cp --only-show-errors s3://$BUCKET/$CODE_KEY /root/ov-bootstrap/ml.tar.gz
tar -xzf /root/ov-bootstrap/ml.tar.gz -C /root/ov-bootstrap --no-same-owner
bash /root/ov-bootstrap/ml/deploy/install.sh
EOF
  [ "$ROLE_CREATED" = yes ] && { echo "waiting 15s for the new instance profile to propagate"; sleep 15; }
  # Not every zone has every GPU type; try each default subnet in a zone that offers it.
  # Default subnets give the instance a public IP (new on every start; the API looks it up).
  ZONES=$(aws ec2 describe-instance-type-offerings --location-type availability-zone \
    --filters "Name=instance-type,Values=$INSTANCE_TYPE" --query 'InstanceTypeOfferings[].Location' --output text)
  for zone in $ZONES; do
    SUBNET=$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC" "Name=availability-zone,Values=$zone" \
      "Name=default-for-az,Values=true" --query 'Subnets[0].SubnetId' --output text)
    [ "$SUBNET" = None ] && continue
    for attempt in 1 2 3; do
      if IID=$(aws ec2 run-instances --image-id "$AMI" --instance-type "$INSTANCE_TYPE" \
          --subnet-id "$SUBNET" --security-group-ids "$SG" \
          --iam-instance-profile "Name=$NAME" --user-data "file://$TMP/user-data.sh" \
          --instance-initiated-shutdown-behavior stop \
          --metadata-options HttpTokens=required,HttpEndpoint=enabled \
          --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME},{Key=App,Value=$APP_NAME}]" \
                               "ResourceType=volume,Tags=[{Key=Name,Value=$NAME},{Key=App,Value=$APP_NAME}]" \
          --query 'Instances[0].InstanceId' --output text 2>"$TMP/err"); then
        echo "launched $IID in $zone"; break 2
      fi
      if grep -q "Invalid IAM Instance Profile" "$TMP/err" && [ "$attempt" -lt 3 ]; then
        echo "instance profile not ready, retrying"; sleep 10; continue
      fi
      echo "no luck in $zone: $(cat "$TMP/err")"; IID=None; break
    done
  done
  [ "$IID" = None ] && { echo "ERROR: could not launch $INSTANCE_TYPE in any zone" >&2; exit 1; }
fi
INSTANCE_ARN="arn:aws:ec2:$AWS_REGION:$ACCOUNT_ID:instance/$IID"

# ------------------------------------------------------------------ Extend the API and CI roles
log "Let the API start the instance and CI ship the code"
cat > "$TMP/api-policy.json" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "ec2:StartInstances", "Resource": "$INSTANCE_ARN" },
    { "Effect": "Allow", "Action": "ec2:DescribeInstances", "Resource": "*" }
  ]
}
JSON
aws iam put-role-policy --role-name "$APP_NAME-apprunner-task" --policy-name transcriber --policy-document "file://$TMP/api-policy.json"
cat > "$TMP/ci-policy.json" <<JSON
{ "Version": "2012-10-17", "Statement": [{ "Effect": "Allow", "Action": "s3:PutObject",
  "Resource": "arn:aws:s3:::$BUCKET/system/transcriber/*" }] }
JSON
aws iam put-role-policy --role-name "$APP_NAME-github-deploy" --policy-name transcriber-code --policy-document "file://$TMP/ci-policy.json"
echo "App Runner task role and deploy role extended"

# ------------------------------------------------------------------ App Runner
log "App Runner service settings"
SERVICE_ARN=$(aws apprunner list-services --query "ServiceSummaryList[?ServiceName=='$APP_NAME'].ServiceArn" --output text)
if [ -z "$SERVICE_ARN" ]; then
  echo "no App Runner service yet; scripts/deploy-init.sh adds these settings when it creates it"
else
  for i in $(seq 1 80); do
    STATUS=$(aws apprunner describe-service --service-arn "$SERVICE_ARN" --query Service.Status --output text)
    [ "$STATUS" != OPERATION_IN_PROGRESS ] && break
    [ "$i" -eq 1 ] && printf 'waiting for an in-progress App Runner operation'
    printf '.'; sleep 15
  done
  echo
  param_arn() { echo "arn:aws:ssm:$AWS_REGION:$ACCOUNT_ID:parameter$PARAMS/$1"; }
  aws apprunner describe-service --service-arn "$SERVICE_ARN" --query Service.SourceConfiguration --output json \
    | jq --arg iid "$IID" --arg token "$(param_arn TRANSCRIBER_TOKEN)" --arg cert "$(param_arn TRANSCRIBER_TLS_CERT)" '
        .ImageRepository.ImageConfiguration.RuntimeEnvironmentVariables.TRANSCRIBER_INSTANCE_ID = $iid
        | .ImageRepository.ImageConfiguration.RuntimeEnvironmentSecrets.TRANSCRIBER_TOKEN = $token
        | .ImageRepository.ImageConfiguration.RuntimeEnvironmentSecrets.TRANSCRIBER_TLS_CERT = $cert' \
    > "$TMP/source.json"
  if aws apprunner describe-service --service-arn "$SERVICE_ARN" --query Service.SourceConfiguration --output json \
      | jq -e --slurpfile want "$TMP/source.json" '. == $want[0]' >/dev/null; then
    echo "already set"
  else
    aws apprunner update-service --service-arn "$SERVICE_ARN" --source-configuration "file://$TMP/source.json" >/dev/null
    echo "set TRANSCRIBER_INSTANCE_ID=$IID and the token and certificate secrets (App Runner is redeploying)"
  fi
fi

log "Done"
cat <<TXT
Instance:  $IID ($INSTANCE_TYPE). First boot installs PyTorch and the weights (~10 min), then it
           stops itself after 15 idle minutes. Starting it again takes ~2 minutes; the API does that.
Status:    aws ec2 describe-instances --instance-ids $IID --query 'Reservations[0].Instances[0].State.Name'
Logs:      aws ssm start-session --target $IID, then: journalctl -u ov-transcriber -f
Cost:      ~\$0.53/hour while running, plus its 75 GB disk (~\$6/month) while stopped.
TXT
