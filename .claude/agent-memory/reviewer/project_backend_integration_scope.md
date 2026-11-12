---
name: backend-integration-scope-conflict
description: Accounts/server storage were flagged out of scope on 2026-10-26; RESOLVED by ADR 0013 + CLAUDE.md scope table (seen 2026-11-12). Still check a no-account .ovproj path exists
metadata:
  type: project
---
On 2026-10-26 `feat/backend-integration` was reviewed. It made accounts required, autosaved display/sync to Postgres and added a profile Preferences store, while CLAUDE.md/ADR 0001 still called those later phase. I flagged it as the first blocker. It also kept the audio-to-score transcription pipeline (`/api/transcriptions`), which is not in the spec (STATE.md open question 6).

Resolution (verified 2026-11-12): `docs/decisions/0013-accounts-in-scope.md` exists, and the CLAUDE.md scope table now lists "accounts and server-side projects (ADR 0013)" as MVP. Account-free mode and public share pages are the later-phase items now.

**Why:** ADR 0001 says later-phase work needs a recorded decision; that decision now exists.

**How to apply:** Do not flag accounts, autosave or server storage as scope creep anymore. Do flag account-free mode, share pages, or surfacing the transcription pipeline without a STATE.md decision. Related: [[recurring-review-findings]].
