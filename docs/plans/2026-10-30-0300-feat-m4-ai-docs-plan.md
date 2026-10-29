---
title: M4 AI-Facing Docs, Tracing Guide and Device Matrix - Plan
type: feat
date: 2026-10-30
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# M4 AI-Facing Docs, Tracing Guide and Device Matrix - Plan

## Goal Capsule

- **Objective:** ship the M4 documentation deliverables of brief §16.6, §14.4 and §5.4:
  - one `AGENTS.md` per package, with "do this, never that" examples for coding assistants;
  - a root `llms.txt` index for the docs;
  - a development tracing guide;
  - the tested device matrix;
  - a host integration guide.

  `pnpm check` checks them, and every link resolves. This is M4 slice 9.
- **Means:**
  - Markdown files;
  - one offline checker script, `scripts/check-docs.ts`, wired into `pnpm check`;
  - its tests.
- **Authority, highest first:**
  1. `AGENTS.md`.
  2. Accepted ADRs. Do not edit any ADR.
  3. This plan.
  4. Brief §5.4, §9.7–§9.9, §14.4 and §16.6.
  5. `docs/system-design.md`.
- **Execution profile:** autonomous.
  - Work offline except for `git push` and `gh` at the end.
  - Work on the existing branch `m4/ai-docs`, which holds one commit with this plan.
  - Open one pull request against `main`.
  - Run U1 to U4 in order, with `pnpm check` after each.
- **Stop conditions:** stop and open a draft pull request that names the blocker when any of these happens:
  - a source file under `packages/` or `examples/` would need a code change, other than adding Markdown files;
  - an existing test assertion must change;
  - a golden, the compatibility matrix or an ADR would change;
  - a dependency or `pnpm-lock.yaml` would change;
  - `pnpm check` still fails after three focused fix attempts on the same cause.
- **Who finishes:** the implementing agent opens the pull request and stops. It never merges.

---

## Product Contract

### Requirements

**Accuracy rule**

- R0. Every statement must match the code on the branch. Each "do" example names a real export, option or file, and each "never" names a real limit or rule from AGENTS.md, an ADR, the system design or the security review.
  - Do not invent APIs, versions or results.
  - Do not describe galaxie as secure, compliant or certified, or as suitable for regulated or high-risk uses.
  - Never copy anything from `internal/`.
  - Code examples are short TypeScript snippets that use only exported names. They are not compiled, so check each name against the package's `src/index.ts` or its subpath entry by reading the source.

**Package docs**

- R1. Each of the seven packages has an `AGENTS.md`:
  - `core`;
  - `adapter-langgraph`;
  - `models`;
  - `react`;
  - `storage-indexeddb`;
  - `tools-mcp`;
  - `eslint-plugin`.

  Each file uses the same sections: `Purpose`, `Entry points` (exports and subpaths), `Do`, `Never`, `Limits` and `Tests` (where its tests live and how to run them). Keep each file short, roughly 40–120 lines, and link to the README or the system design section for detail instead of repeating it.
- R2. `core`, `adapter-langgraph` and `models` have no `README.md` on `main`. `react`, `storage-indexeddb`, `tools-mcp` and `eslint-plugin` have one.
  - Add a short `README.md` to each of the three packages without one, covering purpose, install, a minimal usage example and links.
  - Do not rewrite an existing README beyond adding a link to the new `AGENTS.md`.

**Root docs**

- R3. `llms.txt` at the repository root follows the llms.txt convention: an H1 title, a one-paragraph blockquote summary, then H2 sections of Markdown link lists, each link with a short note. It lists:
  - the brief;
  - the system design;
  - the framework overview;
  - the ADR index or directory;
  - the security review;
  - the exit records;
  - each package's README and `AGENTS.md`;
  - the new guides;
  - the conformance README;
  - the injection corpus README.

  Links are repository-relative paths.
- R4. `docs/guides/tracing.md` is the development tracing guide (brief §14.4). It covers:
  - galaxie calls only the OpenTelemetry API, and the host registers an SDK and exporter;
  - the span tree and its attributes, taken from `packages/core/src/tracing.ts`, with the GenAI convention revision the code records;
  - the default content-free filter;
  - `developmentTraceText` and its destination rule;
  - registering a `WebTracerProvider` with an OTLP/HTTP exporter in host code;
  - sending spans to Langfuse at `/api/public/otel` through a collector the host runs, which adds the credentials. The secret key never ships in the bundle.
  - spans from other instrumentation are outside galaxie's filter.

  Snippets name OpenTelemetry packages only as host-side examples. This slice adds no dependency.
- R5. `docs/guides/host-integration.md` is the host integration guide (brief §5.4). It covers:
  - the CSP and Trusted Types requirements, citing `examples/host-local/src/csp.ts` as the worked example;
  - when COOP and COEP are needed;
  - model hosting and SRI;
  - `persist()`;
  - user-device endpoints and Local Network Access;
  - ownership and logout wiring;
  - confirmations;
  - output safety;
  - development warnings;
  - remote providers through a host proxy with short-lived tokens.

  Each item links to the system design section that defines it.
- R6. `docs/device-matrix.md` lists only what the exit records and CI actually ran, with the date or record for each row:
  - CI: Node 24 and headless Chromium from Playwright 1.64.1, with fakes for WebGPU, Built-in AI and the models;
  - the maintainer's Apple M5 Pro with Chrome 155, per `docs/m2-exit-record.md` and `docs/m3-exit-record.md`, and which checks were real.

  It also lists, as untested: other browsers, mobile, other GPUs, and the unmeasured items those records name.

**Checker**

- R7. `scripts/check-docs.ts` runs offline. It reads tracked Markdown and `llms.txt` through `git ls-files`, excluding `internal/`, `docs/plans/` and `node_modules`. It fails with a file and line message when any of these holds:
  - a relative link or image target does not exist;
  - a `#fragment` link to a Markdown file, or within the same file, names no heading slug in the target. Use GitHub's slug rules: lowercase, punctuation removed except `-` and `_`, spaces become `-`, and duplicate headings get `-1`, `-2` and so on.
  - a package under `packages/` lacks `AGENTS.md` or `README.md`;
  - a package `AGENTS.md` lacks one of the R1 section headings;
  - `llms.txt` lacks an H1, the blockquote or at least one H2 section, or links a path that does not exist.

  External `http(s):` and `mailto:` links are not fetched. Links inside fenced code blocks and inline code are ignored.
- R8. Add `check:docs` to `package.json` and append it to `check`. Add `scripts/check-docs.ts` to the `scripts` tsconfig if needed. Tests go in `tests/conformance/check-docs.node.test.ts` or under `scripts/` following the pattern of `build-manifest.node.test.ts`. They use temporary fixture trees and cover each failure kind, plus the pass case on the real repository.
- R9. Fix any broken link the checker finds in existing tracked docs. Plans are excluded, so they stay as written. Fixes are limited to link targets and fragments, with no change of meaning.
- R10. Link `llms.txt` and the guides from the README. Update the AGENTS.md project status paragraph and the root README status in one sentence each.

### Scope Boundaries

- No docs site generator.
- No external link checking.
- No compiled doc examples.

### Assumptions

- License headers apply to `.ts` files only. Check `scripts/check-license.ts`.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Grounded, terse docs.** Assistant-facing docs are only useful when they are exact. Links to the authoritative sections aid traceability. The checker validates link destinations only, so R0 remains the accuracy requirement.

### Output Structure

```text
llms.txt
docs/guides/tracing.md
docs/guides/host-integration.md
docs/device-matrix.md
packages/*/AGENTS.md (7)
packages/{core,adapter-langgraph,models}/README.md
scripts/check-docs.ts
tests/conformance/check-docs.node.test.ts
```

## Implementation Units

- **U1. Checker.** R7–R9, with fixes for existing broken links. Add `check:docs` as a script, but append it to `check` only in U2, after the package docs exist.
- **U2. Package docs.** R1 and R2, then append `check:docs` to `check`.
- **U3. Guides, matrix and `llms.txt`.** R3–R6.
- **U4. Links and status.** R10.

## Verification Contract

| Gate | Command or check | Applies to |
| --- | --- | --- |
| Full local CI | `pnpm check`, including `check:docs` | every unit |
| CI-mode tests | `CI=true pnpm test` | before the PR |
| No code change | `git diff --stat main -- packages examples` lists only `.md` files. | before the PR |
| Protected paths | `git diff --stat main -- tests/conformance/golden tests/conformance/compatibility-matrix.json docs/adr pnpm-lock.yaml` is empty. | before the PR |

## Definition of Done

- U1 to U4 are complete.
- Every package has an `AGENTS.md`.
- `llms.txt`, the tracing guide, the host integration guide and the device matrix are committed.
- `check:docs` passes in `pnpm check`, and GitHub CI is green.

## Appendix

### Sources

- Brief §5.4, §14.4 and §16.6.
- `packages/core/src/tracing.ts`, `examples/host-local/src/csp.ts`, `docs/m2-exit-record.md`, `docs/m3-exit-record.md` and `docs/security-review.md`.
- The llms.txt convention: an H1, a blockquote summary and H2 link lists.
