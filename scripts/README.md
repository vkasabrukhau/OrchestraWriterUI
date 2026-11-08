# scripts/

All re-runnable. All read `.env`.

| Script | Needs | Does |
|--------|-------|------|
| `aws-env.sh` (`npm run aws:env`) | AWS CLI signed in (collaborator policy in `infra/README.md`) | writes `.env.aws` (gitignored) for `npm run dev:aws` / `db:ping:aws`: Aurora endpoint, bucket, state machine, Google sign-in from SSM when readable |
| `db-init.sh` | DB access | `npm run db:migrate` then `npm run db:seed` (the server also does this on boot) |
| `s3-init.sh` | S3 admin | creates the bucket if missing, blocks public access, sets CORS for `ALLOWED_ORIGINS`, abandons stale multipart uploads |
| `smoke-test.sh [url]` | curl + node, a running server whose `BETTER_AUTH_URL` is that url | end-to-end check: health, sign-up, project flow (presigned score upload, parse job, display, delete), recordings + transcription, sign-out/in, account deletion; default http://localhost:3000. Run before pushing and after deploys. |
| `deploy-init.sh` | AWS admin + `gh` signed in + code pushed to `main` | creates ECR, the three IAM roles, the GitHub OIDC trust, secrets in SSM, triggers the first image build, creates the App Runner service, updates bucket CORS with the live URL. Prints the site URL and the Google redirect URI. Pass `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` to enable Google sign-in. |

What each AWS resource is for is in `infra/README.md`.
