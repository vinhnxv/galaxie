# AGENTS.md

Guidance for coding agents (Claude Code, Codex and others) working in this repository.

## Project status

Read [the project status](docs/status.md) before changing an area. It records implemented behavior, what is verified only with mocks and what is unmeasured.

## Read first

1. `docs/galaxie-project-brief.md`: the source of truth for scope, architecture, security and the roadmap. Start with §0.
2. `docs/adr/`: one file per decision. Follow Accepted ADRs. Proposed ADRs are working defaults that a spike or milestone must confirm.
3. `docs/system-design.md`: components, package boundaries, contracts and runtime flows. Read it before you add a package or change a contract.
4. `docs/framework-overview.md`: role, audiences and the roadmap at a glance.

## Commands

Node.js 24 and pnpm 11 (through Corepack).

- `pnpm install`
- `pnpm check`: everything CI runs. Run it before you report work as done.
- `pnpm format`: apply Biome formatting and safe fixes.

The compiler settings are strict (system design §10): relative imports end in `.js`, type-only imports use `import type`, exported functions declare their return types, and syntax that TypeScript cannot erase, such as `enum`, is not allowed.

## Rules

- Everything committed is in English: code, comments, docs, commit messages, issues and pull requests.
- New source files start with the SPDX header from ADR-0024:
  ```ts
  // SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
  // SPDX-License-Identifier: Apache-2.0
  ```
- Outside contributions are accepted under the Developer Certificate of Origin (ADR-0024): merge outside code only when every commit carries a `Signed-off-by` line that matches its author (`git commit -s`). Every commit, agent commits included, is made with `git commit -s` so it carries a matching `Signed-off-by` line; CI checks this with `scripts/check-dco.ts` (see [CONTRIBUTING.md](CONTRIBUTING.md)). Do not copy or adapt code from anywhere else without checking that its license is compatible with Apache-2.0.
- Never commit secrets: API keys, tokens, credentials or `.env` files. A local gitleaks pre-commit hook blocks them.
- The security baseline (ADR-0012) is mandatory. Never weaken a guarantee to make a test pass.
- Never describe galaxie as secure, compliant, certified or suitable for regulated or high-risk uses, in docs, comments, commit messages or anything user-facing. Describe the controls and their documented limits instead (README, "Intended use and disclaimer").

## Maintainer-only notes

`internal/` is git-ignored here. On the maintainer's machine it is a separate private git repository with its own history. It holds planning, business and legal notes, and raw review outputs.

- Read it when it is present and relevant to the task.
- Git commands run inside `internal/` act on that repository, not on this one.
- Never copy its content into tracked files, commit messages, pull requests or issues.
- Never remove `/internal/` from `.gitignore` or force-add files from it.

Two local tools are git-ignored the same way. They exist only where the maintainer set them up:

- `.codegraph/`: the CodeGraph index of this repository. When it is present, use it to locate and read code. Run `codegraph sync` if it looks stale.
- `.beads/`: the Beads (`bd`) backlog, kept out of this repository (stealth mode). Use it for work that spans sessions. It is tracker content, so write it in English.
  - Never copy it into tracked files, and never let `bd` use this repository's remote as its Dolt remote.
  - Never change its Dolt remote, or run `bd dolt push` or `bd sync`, without the maintainer's approval.
