---
name: owner-intent-priority
description: Owner fidelity (criterion G) outranks scope/perf/a11y/data/test fixes in plan reviews; the Sync revamp plan lost owner asks to a11y and scope trims
metadata:
  type: project
---
On 2026-11-09 the product owner set "what the owner wants" (criterion G) as the top criterion in Sync revamp plan reviews. If a fix for another criterion conflicts with the owner's words, the owner's words win.

**Why:** Over rounds 1–4, reviewer fixes and lead decisions slowly traded away owner asks. Examples: the Measures-row marker glyph was made non-interactive for a11y, although the owner wrote "Whenever a marker is displayed it will have an icon. Upon press you can see its details". Suggested markers were hidden by default on confident bars, although the owner asked that they be "visible and editable".

**How to apply:** Check every lead decision and a11y/perf fix against the owner's spec, `docs/plan/sync-page-revamp.md`. Rank findings by how far they stray from the owner's words. When the owner's ask and the other constraint can both be met (for example, a pressable marker icon outside the listbox option), propose that. Related: [[sync-revamp-traps]], [[sync-data-conventions]].
