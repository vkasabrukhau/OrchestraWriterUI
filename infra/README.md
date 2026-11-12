# AWS resources

Everything is in `us-east-1`. Created by `scripts/deploy-init.sh` unless noted.

| Resource | Name | Purpose |
|----------|------|---------|
| Aurora PostgreSQL cluster | `orchestra-db-1` (pre-existing) | application tables; IAM auth, TLS required |
| S3 bucket | `orchestra-writer-s3` (pre-existing) | audio recordings; private, presigned URLs only, CORS for the site origin |
| ECR repository | `orchestra-writer` | container images built by GitHub Actions |
| App Runner service | `orchestra-writer` | runs the image on port 3000 (1 vCPU / 2 GB); auto-deploys when `:latest` changes |
| IAM OIDC provider | `token.actions.githubusercontent.com` | lets GitHub Actions assume a role with no stored keys |
| IAM role | `orchestra-writer-github-deploy` | assumed by the workflow: push to ECR, read App Runner status |
| IAM role | `orchestra-writer-apprunner-ecr` | lets App Runner pull from ECR (AWS managed policy) |
| IAM role | `orchestra-writer-apprunner-task` | the running server: `rds-db:connect`, bucket read/write, read SSM secrets |
| SSM parameters | `/orchestra-writer/BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | injected into the service as env vars |
| GitHub repo variable | `AWS_DEPLOY_ROLE_ARN` | read by `.github/workflows/deploy.yml`; must be set on **this** repo (see below) |

## This repo and AWS

The code moved from `SulaimanKhydyrDUKE/OrchestraWriter` to
`vkasabrukhau/OrchestraWriterUI`; the AWS resources above did not move and are
shared. Two things connect this repo to them:

**Local development against AWS.** `npm run aws:env` writes `.env.aws`
(gitignored) from AWS with your own `aws configure` credentials: the Aurora
endpoint, the bucket, the state machine ARN and, if you may read SSM, the
Google sign-in pair. Then `npm run db:ping:aws` and `npm run dev:aws`. Plain
`npm run dev` still uses the docker compose stack. This repo is public: never
commit `.env.aws` or paste its values into a tracked file.

`dev:aws` migrates the shared database on boot like the deployed server does.
Migrations here are additive (new tables, nullable columns), so the deployed
app keeps working; do not add a destructive one without coordinating.

**Deploys from GitHub Actions.** The `orchestra-writer-github-deploy` role
trusts `repo:vkasabrukhau/OrchestraWriterUI:environment:production` and
`...:ref:refs/heads/main`, each also in GitHub's id form
(`repo:vkasabrukhau@<ownerId>/OrchestraWriterUI@<repoId>:...`), and still the
old repo. The `environment:production` subject is the one that matters: the
deploy job runs in the `production` environment, and GitHub then sends the
environment instead of the branch. The repo variable that turns deploys on is
set (2026-11-12):

```bash
gh variable set AWS_DEPLOY_ROLE_ARN -R vkasabrukhau/OrchestraWriterUI \
  --body arn:aws:iam::ACCOUNT_ID:role/orchestra-writer-github-deploy
```

The App Runner health check must be HTTP `/api/health` (the API lives under
`/api`). The old app answered only `/health`; `scripts/deploy-init.sh` sets the
right path. The deploy workflow fails when App Runner rolls a deployment back,
so a failed health check shows up as a red run.

## Transcription pipeline (Step Functions + Lambda): parked

`scripts/pipeline-init.sh` created a state machine and six Lambdas
(`orchestra-writer-split|transcribe|merge|notate|finalize|fail`). They are no
longer deployed from CI, and nothing here calls them: the routes are mounted
only with `PIPELINE_ENABLED=1`, the model step is still a placeholder, and the
whole pipeline had run twice (both tests, 2026-10-23). Idle Lambdas and a
state machine cost nothing; the worker images in ECR cost cents.

The shape does not fit a real model either. MuScriptor decodes a recording
in order (each chunk is conditioned on the previous one so instruments stay
consistent), needs a GPU to run near real time, and can exceed Lambda's
15-minute limit, so 30-second chunks fanned out to 20 Lambdas is the wrong
split. When transcription ships, run one GPU job per recording (AWS Batch on
spot GPU instances, or SageMaker asynchronous inference; both scale to zero),
started by Step Functions or the API, and keep Lambda for small glue. The
MuScriptor weights are CC BY-NC: non-commercial use only. To retire the old
resources instead: delete the six functions, the state machine, the
`orchestra-writer-worker` ECR repository and role, and unset
`STATE_MACHINE_ARN` on the App Runner service.

## Policy for a collaborator running locally

Attach to an IAM user (then `aws configure` with its access key) or a role they can assume. Replace `ACCOUNT_ID` and `CLUSTER_RESOURCE_ID` (`aws rds describe-db-clusters --db-cluster-identifier orchestra-db-1 --query 'DBClusters[0].DbClusterResourceId'`).

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "rds-db:connect",
      "Resource": "arn:aws:rds-db:us-east-1:ACCOUNT_ID:dbuser:CLUSTER_RESOURCE_ID/postgres" },
    { "Effect": "Allow", "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::orchestra-writer-s3" },
    { "Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::orchestra-writer-s3/*" }
  ]
}
```

This grants a login to the database, not table permissions; those come from the Postgres role. Today everyone connects as `postgres`. A follow-up is a dedicated `app` role with `GRANT rds_iam TO app` and only the privileges the server needs.

## Known gaps

- The cluster is Serverless v2 with min 0 ACU and a 300s auto-pause. The first request after 5 idle minutes waits ~15s while it resumes (the pool allows 30s). Raise min capacity to 0.5 ACU to remove the pause if that delay bothers users; it costs roughly an always-on small instance.

- Aurora is reachable from the internet on 5432 (TLS and IAM token still required). A VPC connector + NAT gateway would close it.
- Backup retention was 1 day and deletion protection off at setup time. Raise to 7+ days and enable protection.
- No custom domain; the App Runner URL is the site URL. Changing it means re-registering the Google redirect URI and re-running `deploy-init.sh`.
