---
title: M4 MVP Exit Record and Unsupported Features - Plan
type: feat
date: 2026-10-30
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# M4 MVP Exit Record and Unsupported Features - Plan

## Goal Capsule

- **Objective:** prepare the evidence the MVP release gate needs (brief §16.6 and §18):
  - an MVP exit record mapping each acceptance test, AT-01 to AT-36, to the evidence that exists on `main`;
  - a public list of unsupported features;
  - the inputs to the Go/Revise decision.

  The maintainer makes the Go/Revise decision. This slice records inputs only and never states a verdict. This is M4 slice 10, the last MVP source slice.
- **Means:**
  - `docs/mvp-exit-record.md`;
  - `docs/unsupported.md`;
  - one Node test that keeps the record consistent with the repository;
  - links and status updates.
- **Authority, highest first:**
  1. `AGENTS.md`.
  2. Accepted ADRs. Do not edit any ADR.
  3. This plan.
  4. Brief §16.6, §17 (the AT table) and §18.
  5. `docs/system-design.md`, `docs/security-review.md`, `docs/device-matrix.md`, `docs/m2-exit-record.md`, `docs/m3-exit-record.md` and `tests/conformance/README.md`, with its compatibility matrix.
- **Execution profile:** autonomous.
  - Work offline except for `git push` and `gh` at the end.
  - Work on the existing branch `m4/mvp-exit`, which holds one commit with this plan.
  - Open one pull request against `main`.
  - Run U1 to U3 in order, with `pnpm check` after each.
- **Stop conditions:** stop and open a draft pull request that names the blocker when any of these happens:
  - any file under `packages/` or `examples/` would change;
  - an existing test assertion must change;
  - a golden, the compatibility matrix or an ADR would change;
  - a dependency or `pnpm-lock.yaml` would change;
  - `pnpm check` still fails after three focused fix attempts on the same cause.
- **Who finishes:** the implementing agent opens the pull request and stops. It never merges.

---

## Product Contract

### Requirements

**Accuracy rule**

- R0. Every claim must cite evidence that exists on the branch: a test file with its exact `test`/`it` name, or a section of an exit record.
  - Do not invent tests, runs, devices or numbers.
  - Where evidence is missing or partial, say so plainly.
  - Do not describe galaxie as secure, compliant or certified, or as suitable for regulated or high-risk uses.
  - Never copy from `internal/`.
  - Never state that the MVP passes, is a Go, or is ready to release.

**Exit record (`docs/mvp-exit-record.md`)**

- R1. A header gives the date, the commit it describes, and the statement that it records evidence for the maintainer's Go/Revise decision (§18) and makes no decision.
- R2. **Acceptance tests table.** One row per AT-01 to AT-36, in order, with these columns:
  - the ID;
  - the short name from the brief;
  - the evidence status: `automated`, `automated + real-device demonstration`, `partial` or `gap`;
  - the evidence, as test files with test names, or exit-record sections;
  - what is mocked or not measured.

  Use `partial` when only part of the requirement has evidence. For example, AT-29 tags requests, but no fixture rejects requests to a sensitive endpoint. Use `gap` when there is no evidence. Read the brief's full requirement text for each AT before classifying it, and reuse the mappings already made in `docs/security-review.md`, the M2 and M3 exit records and the conformance README.
- R3. **Engineering checks** (§18), each with its bar and the evidence:
  - framework parity: AT-15, the compatibility matrix and its listed differences;
  - fault-injection recovery: AT-08, AT-09 and AT-31;
  - main-thread long tasks over 50 ms: say that this is unmeasured, citing the M2 record.
- R4. **Demonstrations** (§18): list each metric with its recorded value and source, or "not recorded". Never invent a value. The second external developer trial is listed as not done.
- R5. **Deliverables of §16.6:** one line each, naming the merged evidence path. Spike D: check the repository and the brief for its status, and record exactly what exists. If nothing exists, say it was not run.
- R6. **Open items for the decision:** every `partial`, `gap` and unmeasured item, and every human-only task, such as the external developer trial, real-device runs, the legal review in brief §9.8, and the decision itself. Facts only, with no recommendation.

**Unsupported features (`docs/unsupported.md`)**

- R7. A public list, grouped by area (execution and LangGraph, models and providers, UI, storage and recovery, tools and MCP, security, platforms). Each entry has one sentence and a link to where it is documented.
  - Collect the entries from the system design, the package READMEs and `AGENTS.md` files, the compatibility matrix, the security review and the device matrix.
  - Include at least:
    - parallel interrupts, static breakpoints, ID-less interrupts and multiple requests per node;
    - async context without real `AsyncLocalStorage`;
    - no sandbox under the trusted-first model;
    - no unknown-outcome reconciliation API;
    - draft persistence;
    - per-call provider caps and the download-consent UI, if still unimplemented;
    - payments, password changes and account deletion;
    - third-party MCP servers;
    - untested browsers and devices.

  Re-check each item against the current code before listing it. Do not list anything that has since shipped.

**Consistency test**

- R8. `tests/conformance/mvp-exit-record.node.test.ts` (Node only) reads both docs and the brief, and fails when:
  - the exit-record table lacks a row for any AT ID in the brief's AT table, or has duplicates or rows out of order;
  - a row's status is not one of the four allowed values;
  - a cited test file under `tests/`, `packages/` or `examples/` does not exist;
  - a quoted test name does not appear verbatim in its cited file. A name built from a template, such as one containing `%s`, may be matched up to its first placeholder.

  `check:docs` already validates links.
- R9. Link both docs from the README, `llms.txt` and system design §1 or §9. Update the AGENTS.md status paragraph and the README status, saying that the MVP evidence is recorded and the decision is pending.

### Scope Boundaries

- No new runtime behavior or tests of product behavior.
- No real-device runs.
- No Go/Revise decision.
- No closing of gaps. Gaps are recorded only.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **The record lists evidence. The maintainer decides.** §18 makes Go/Revise a maintainer decision based on parity, the acceptance tests and the engineering checks. A test keeps the record from drifting away from the tests it cites.

### Output Structure

```text
docs/mvp-exit-record.md
docs/unsupported.md
tests/conformance/mvp-exit-record.node.test.ts
```

## Implementation Units

- **U1. Exit record.** R1–R6.
- **U2. Unsupported features.** R7.
- **U3. Consistency test, links and status.** R8 and R9.

## Verification Contract

| Gate | Command or check | Applies to |
| --- | --- | --- |
| Full local CI | `pnpm check`, including `check:docs` | every unit |
| CI-mode tests | `CI=true pnpm test` | before the PR |
| No code change | `git diff --stat main -- packages examples` is empty. | before the PR |
| Protected paths | `git diff --stat main -- tests/conformance/golden tests/conformance/compatibility-matrix.json docs/adr pnpm-lock.yaml` is empty. | before the PR |

## Definition of Done

- U1 to U3 are complete.
- Every AT has a row with honest evidence.
- The unsupported-features list is public and linked.
- `pnpm check` and `CI=true pnpm test` pass, and GitHub CI is green.

## Appendix

### Sources

- Brief §9.8, §16.6, §17 (the AT table) and §18.
- `docs/security-review.md`, `docs/device-matrix.md`, `docs/m2-exit-record.md`, `docs/m3-exit-record.md`, `tests/conformance/README.md` and the compatibility matrix.
