# ksc_metaverse — Project Rules

ZEP-style in-house 2D metaverse service (pixel avatars, movement + text chat), extended 2026-08-31 with a Baram-style hunting/combat/inventory subsystem. Current direction is the 2009–2010 PC 바람의나라 MMORPG roadmap — see `docs/roadmap.md` for background, scope and the R01–R10 plan.

**This file is the live rule set and it is git-tracked on purpose**, so every PC and session reads the same rules instead of each keeping its own copy. The project root outside this repo holds only a pointer. Rules change here, in a commit, never in a session's local file.

## Roadmap Is Updated With The Work, Never After (MANDATORY — user order 2026-09-18)

Any change in this repo updates `docs/roadmap.md` **in the same commit**. This is a rule, not a preference.

- Status columns, the `§7 다음 작업` table, and the item's own `§5` bullets all move with the code. A commit that ships an item but leaves it reading `PLANNED` is an incomplete commit — fix the doc before committing, not in a follow-up.
- State what is actually true, separately: **code done ≠ item done.** If the item's own completion condition needs a human (visual approval, playing the loop, an SSO browser), say the code is done and name what still blocks the item. Never close an item on the strength of passing tests alone.
- The roadmap is the one place a session on another PC looks first. It drifted once already (R03/R04 read `PLANNED` while all three R04 stages were shipped and pushed), which is exactly the failure moving it into git was meant to prevent.
- The same applies to this file: a rule the user states is written here in the commit that acts on it.

## Agent Timeboxing (MANDATORY, 2026-09-11 — user complaint after a 40-minute silent wait)

Subagents buy context isolation and buy **nothing** in visibility. Closing that gap is the caller's job.

- **Check the working tree, never relay "still running."** Before reporting an agent's status, run `git status --short` / check the record file. Files on disk are the progress signal; the agent's silence is not.
- **Timebox every spawn.** Delegated work gets a stated budget (default 20 min). At the budget: inspect the tree, then either take over directly or redirect with a narrower instruction. The user asking "why so slow" must never be the first checkpoint.
- **Delegate only what pays for the round trip.** ≤3 files, or a change whose shape is already known, is faster done directly — a spawn costs 5–15 min of re-reading the repo before the first edit.
- **One verification pass, not per-agent.** Agents run targeted tests only. The full suite (`client/e2e`, server) runs **once**, by the caller, right before the commit. Never ask an agent for "N-time reproduction" of a suite that takes minutes.
- **Full pipeline (architect→coder→tester→guardian→reviewer) is for DB/concurrency/auth/protocol changes only.** It earned its cost on Phase W-1 (a real level-drop race) and has now caught an implementer-verified defect on three consecutive settlement stages (R04-a Critical+High, R04-b High, R04-c Medium). For UI/copy/asset work it is pure latency — one implementer + caller verification.
- A regression test that passes both with and without the fix is worthless. **Revert the fix and confirm the test fails** before reporting it.

## Folder Separation (MANDATORY)

- This repo — actual implementation only.
- `../docs/` (project root, outside this repo) — historical design/review/implementation records up to 2026-09-15. Not git-tracked; frozen as reference, no longer the live source.
- **`docs/roadmap.md` is the single official roadmap (2026-09-16 decision).** `docs/decisions.md` and `docs/history/` are the live decision log and completed-work history.

Never create source files under either `docs/` folder. Planning/review docs go under this repo's `docs/`, not the old root one.

## Markdown Discipline (MANDATORY, replaces the 2026-09-09 per-task record rule — user order 2026-09-17)

Keep as few `.md` files in the git path as possible. Fewer, denser, current — not an archive of every task.

- **Never create a new `.md` file unless the user asked for one.** Default to adding a section to the existing item doc, or a single line in `decisions.md`. Creating files nobody asked for is what produced the 49-file / 12,826-line root `docs/` sprawl; being short a record has never once cost this project anything.
- **One doc per roadmap item**, named `docs/r<NN>-<topic>.md`, holding design + implementation + verification together. Never a per-task or per-date file: `implementation-YYYY-MM-DD-*.md` and `verification-*.md` are retired shapes. Extend the item's doc instead.
- Fixed set in the git path: `roadmap.md` (the only roadmap, anywhere), `decisions.md`, one `r<NN>-*.md` per active item, and the standing reference docs (`avatar-manifest.md`, `master-adventurer.md`, `pixel-art-production.md`).
- **Delete what is superseded in the same commit** that supersedes it, and repoint every reference — code comments included. Git history is the archive; a stale file in the tree is not. Run a dangling-link grep before committing.
- A small change records itself in `decisions.md` alone. Do not create a file for it.
- What a record must still carry: purpose, actual changes, verification commands **with real output**, checks not run and why, remaining limits. Keep proposal / implemented / verified / deployed distinct.
- Implementation is not complete until its section is written. Link it in the final handoff.
- Code comments citing `design-phase-*.md` / `design-hunting-*.md` and other pre-2026-09-15 filenames point at the **frozen root `../docs/`** (outside git, see Folder Separation), not at a missing repo file. Leave them: they carry the reasoning behind decisions this repo still relies on. Never add a *new* comment pointing outside the git path — cite `docs/r<NN>-*.md` or the defining code instead.

## Implementation Gate (MANDATORY)

- Do not write code into this repo — not even scaffolding, boilerplate, or a "starter" structure — until the user gives an explicit go-ahead for that specific piece of work. Discussion, design, and roadmap edits do not count as approval.
- Record the approval in `docs/decisions.md` **before the first action**, not after. A reviewer or tester arriving with no context otherwise reports shipped work as unauthorized.
- When asked to design or investigate (tile format, WS auth PoC, broadcast optimization, etc.), produce the analysis/design as a doc under `docs/`, not as code.

## Git

- All work, commits and pushes happen on `main`. No branches, no MR. `origin` pushes to both GitLab and the GitHub backup mirror.
- Fetch `origin` and check divergence from `origin/main` before starting repository work.
- **An instruction to commit includes pushing** (user rule 2026-09-18) — do not ask separately. Always show the actual file list / `git diff --stat` immediately before committing.

## Go/No-go PoCs (blocking)

1. WebSocket upgrade request carries SSO auth headers/cookies through the KAD gateway (APISIX) — unverified.
2. Single-room 500 CCU broadcast performance with interest management + tick-rate limiting — unverified.

Both gate KAD operation at scale, not the local build. Do not claim either as satisfied without a measurement.

## Out of Scope

- Voice/video features.
- ZEP premium features (GA integration, log download, custom URL/logo, etc.).
- LLM-based features (AI NPCs and the like) — explicitly refused by the user 2026-08-28.
- General-purpose scripting engine for map objects (fixed, pre-defined object types only).
