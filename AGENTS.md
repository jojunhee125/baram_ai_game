# ksc_metaverse — Repository Rules (single source for every agent)

**This file is the one rule set for this repository.** Two agents work here on two PCs: **Codex** reads this file directly; **Claude Code** reads `CLAUDE.md`, which imports this file (`@AGENTS.md`). Rules change **here only**, in a commit. Never keep a second copy of a rule anywhere else.

**Precedence:** this file overrides any global or user-level workflow (`~/.codex/AGENTS.md`, `~/.claude/CLAUDE.md`, skills, agent defaults) wherever they conflict — especially on documentation. A global rule that says "create an implementation record per task" is satisfied **by the item-doc section below**, never by a new dated file.

## Session Start

1. `git fetch --prune origin`, check status and divergence from `origin/main`. Preserve existing local edits; sync `main` before starting, never discard work to force it.
2. Read `docs/open-concerns.md` (if present) — open issues awaiting a user decision. Do not resolve any of them without that decision.
3. Read `docs/roadmap.md` — the **only** current-state and plan document.

## Git

- All work, commits and pushes happen on `main`. No branches, no MR. `origin` pushes to both GitLab (primary) and the GitHub backup mirror.
- Commits are free-form: size and grouping are not rules. An instruction to commit includes pushing. Show `git diff --stat` right before committing.

## Documentation (MANDATORY — user order 2026-09-17, re-confirmed 2026-09-23)

The 2026-09-23 switch to per-date implementation records (`9560690`) was **never authorized by the user** and is void.

- Fixed set in `docs/`: `roadmap.md` (the only roadmap and the only current-state summary), `decisions.md` (approvals and decisions, newest first), **one `r<NN>-<topic>.md` per roadmap item**, standing references (`avatar-manifest.md`, `master-adventurer.md` = R01, `pixel-art-production.md`), `history/`, and `open-concerns.md` while it has entries.
- **Never create a per-date or per-task file** (`implementation-YYYY-MM-DD-*.md`, `design-YYYY-MM-DD-*.md`, `verification-*.md`, `review-*.md`, session-close notes). Never create any new `.md` unless the user asked for it.
- Every implementation still leaves a record — as a **section in the item's `r<NN>-*.md`**: purpose, actual changes, verification commands with real output, checks not run and why, remaining limits. Keep proposal / implemented / verified / deployed distinct. A small change is one line in `decisions.md`.
- `roadmap.md` top has **one** "현재 상태" block. Rewrite it in place; never stack dated announcements above it.
- No second state file. `PROJECT_MEMORY.md` is a pointer only — do not write status there.
- Delete what is superseded in the same commit and repoint every reference (code comments included). Run a dangling-link grep before committing.
- Code comments citing pre-2026-09-15 `design-phase-*.md` / `design-hunting-*.md` point at the frozen `../docs/` outside git. Leave them; never add a new comment pointing outside the git path.

## Roadmap Moves With The Work (MANDATORY — user order 2026-09-18)

- Any change in this repo updates `docs/roadmap.md` in the same commit: status columns, `§7 다음 작업`, the item's `§5` bullets.
- **Code done ≠ item done.** If an item's completion condition needs a human (visual approval, playing the loop, an SSO browser), say the code is done and name what still blocks it. Never close an item on passing tests alone.

## Implementation Gate (MANDATORY)

- Do not write code — not even scaffolding — until the user explicitly approves that specific piece of work. Discussion, design and roadmap edits are not approval.
- Record the approval in `docs/decisions.md` **before the first action**. A reviewer without context otherwise reports shipped work as unauthorized.
- Design/investigation requests produce a section in the item doc, not code.

## Verification

- Subagents run targeted tests only; the full suite runs once, by the caller, right before the commit.
- A regression test that passes with and without the fix is worthless — revert the fix and confirm the test fails.
- Delegated work gets a time budget (default 20 min). Check the working tree for progress; never relay "still running".
- Full multi-agent pipelines are for DB/concurrency/auth/protocol changes only.

## Folder Separation

- This repo holds the implementation and the live docs above. `../docs/` (outside git) is a frozen pre-2026-09-15 archive.
- Never create source files under either `docs/` folder.

## Go/No-go PoCs (blocking)

1. WebSocket upgrade carries SSO auth headers/cookies through the KAD gateway (APISIX) — unverified.
2. Single-room 500 CCU broadcast with interest management + tick-rate limiting — unverified.

Both gate KAD operation at scale. Never claim either without a measurement.

## Out of Scope

- Voice/video; ZEP premium features (GA, log download, custom URL/logo).
- LLM-based features (AI NPCs etc.) — refused by the user 2026-08-28.
- General-purpose scripting for map objects (fixed object types only).

## Codex Only

- Route documentation drafting/editing/review to `doc-writer` on `gpt-6-luna`, **within the Documentation rules above** (they override the global doc workflow).

## Claude Only

- Claude-specific notes live in `CLAUDE.md` below its `@AGENTS.md` import, and must not restate or contradict this file.
