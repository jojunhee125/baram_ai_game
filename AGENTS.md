# Repository Rules

- **At session start, read `docs/open-concerns.md` first.** It lists open concerns. #3 (two agents following different doc rules) is a user-confirmed MUST-FIX: the rule flip in 9560690 was never authorized and doc rules must be unified into one. The others await a user decision.

- Perform all work, commits, and pushes on `main`. Do not create branches.
- Before repository work, fetch `origin` and inspect status and divergence from `origin/main`.
- Preserve all existing local edits. Sync `main` with `origin/main` before starting; never discard work to force synchronization.
- Keep the execution roadmap in `docs/roadmap.md`; record detailed implementation evidence in linked documentation.
- Route all documentation drafting, editing, summarizing, and review to `doc-writer` on `gpt-6-luna` only; follow the global documentation workflow in `~/.codex/AGENTS.md`.
