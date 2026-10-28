# AGENTS.md

Guidance for coding agents (Claude Code, Codex and others) working in this repository.

## Project status

galaxie is in the design phase. There is no package code yet. Milestone M0 (feasibility spikes) comes first; spike code is throwaway and never becomes package code (brief §16.2).

## Read first

1. `docs/galaxie-project-brief.md`: the source of truth for scope, architecture, security and the roadmap. Start with §0.
2. `docs/adr/`: one file per decision. Follow Accepted ADRs. Proposed ADRs are working defaults that a spike or milestone must confirm.
3. `docs/framework-overview.md`: role, audiences and the roadmap at a glance.

Handoff prompts: brief §21 (implementation) and §22 (review).

## Rules

- Everything committed is in English: code, comments, docs, commit messages, issues and pull requests.
- New source files start with the SPDX header from ADR-0015:
  ```ts
  // SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
  // SPDX-License-Identifier: AGPL-3.0-only
  ```
- Do not merge, copy or adapt code from outside contributors. There is no contributor license agreement yet (ADR-0015).
- Never commit secrets: API keys, tokens, credentials or `.env` files. A local gitleaks pre-commit hook blocks them.
- The security baseline (ADR-0012) is mandatory. Never weaken a guarantee to make a test pass.
- Never describe galaxie as secure, compliant, certified or suitable for regulated or high-risk uses, in docs, comments, commit messages or anything user-facing. Describe the controls and their documented limits instead (README, "Intended use and disclaimer").

## Maintainer-only notes

`internal/` is git-ignored here. On the maintainer's machine it is a separate private git repository with its own history. It holds planning, business and legal notes, and raw review outputs.

- Read it when it is present and relevant to the task.
- Git commands run inside `internal/` act on that repository, not on this one.
- Never copy its content into tracked files, commit messages, pull requests or issues.
- Never remove `/internal/` from `.gitignore` or force-add files from it.
