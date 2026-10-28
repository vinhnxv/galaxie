# AGENTS.md

Guidance for coding agents (Claude Code, Codex and others) working in this repository.

## Project status

galaxie has its first four M1 runtime slices: `packages/core` provides lifecycle, identity, cancellation, replayable in-memory events, allowlisted OpenTelemetry spans, a capability broker with grants and validation, sticky data labels and argument shapes, and finite budgets for steps, tool calls, wall clock, payloads, tokens and cost. Its model router enforces ordered per-role providers, destination classes, labels, shared consent and per-call credentials, and publishes selected routes in snapshots. `packages/core` also owns run segments and an in-memory accepted/consumed submission inbox with checkpoint-confirmed, deduplicated dispatch. `packages/adapter-langgraph` routes native chat calls, reads pending interactions from checkpoints and resumes them by interrupt ID; `requestInteraction(request, config)` works after an await on Node and Chromium. Its twelve conformance cases cover interrupts, subgraph re-execution and durability modes. The adapter installs a synchronous context shim only when no global context exists; Node hosts needing async LangChain context must initialize real `AsyncLocalStorage` before the first prepare (system design §6). Parallel interrupts, static breakpoints, ID-less interrupts and multiple requests per node remain unsupported; `packages/models` ships only a deterministic mock provider. Real providers, availability probing, first-run download order, structured output through the router, per-call provider token caps, persistence and UI remain unimplemented. Spikes run only when a milestone needs their answer (brief §16.2). Spike code is throwaway: keep it out of `packages/` and never promote it to package code.

Routing, labels, consent and model budgets apply only through `host.langchain.chatModel(role)`; trusted agent code holding its own model can bypass them (ADR-0002). `maxTokens` is a reservation, so a call can use more and an actual-usage overrun fails the run only after that call returns. `getCredential` hands credentials to page code per call, where XSS or a malicious same-origin dependency can read them. Hosts should supply short-lived, host-proxy-scoped tokens rather than long-lived provider keys (ADR-0012).

## Read first

1. `docs/galaxie-project-brief.md`: the source of truth for scope, architecture, security and the roadmap. Start with §0.
2. `docs/adr/`: one file per decision. Follow Accepted ADRs. Proposed ADRs are working defaults that a spike or milestone must confirm.
3. `docs/system-design.md`: components, package boundaries, contracts and runtime flows. Read it before you add a package or change a contract.
4. `docs/framework-overview.md`: role, audiences and the roadmap at a glance.

Handoff prompts: brief §21 (implementation) and §22 (review).

## Commands

Node.js 24 and pnpm 11 (through Corepack).

- `pnpm install`
- `pnpm check`: everything CI runs. Run it before you report work as done.
- `pnpm format`: apply Biome formatting and safe fixes.

The compiler settings are strict (system design §10): relative imports end in `.js`, type-only imports use `import type`, exported functions declare their return types, and syntax that TypeScript cannot erase, such as `enum`, is not allowed.

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

Two local tools are git-ignored the same way. They exist only where the maintainer set them up:

- `.codegraph/`: the CodeGraph index of this repository. When it is present, use it to locate and read code. Run `codegraph sync` if it looks stale.
- `.beads/`: the Beads (`bd`) backlog, kept out of this repository (stealth mode). Use it for work that spans sessions. It is tracker content, so write it in English.
  - Never copy it into tracked files, and never let `bd` use this repository's remote as its Dolt remote.
  - Never change its Dolt remote, or run `bd dolt push` or `bd sync`, without the maintainer's approval.
