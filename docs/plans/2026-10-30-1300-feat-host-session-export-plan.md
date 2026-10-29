---
title: Host-Local Session Export Actions - Plan
type: feat
date: 2026-10-30
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Host-Local Session Export Actions - Plan

## Goal Capsule

- **Objective:** finish AT-19: "personal content only on explicit action". `IndexedDBSaver.exportSession(sessionId, { personalContent })` exists, but no host binds it to a user action. Add two explicit export actions to `examples/host-local`.
  - "Export session summary" exports metadata only.
  - "Export my answers" exports with `personalContent: true`, behind a confirmation step the host renders.

  Both download a JSON file. This is closeout 2, slice 5.
- **Means:** host-local UI, a loop test and docs.
- **Authority, highest first:**
  1. `AGENTS.md`.
  2. Accepted ADRs, in particular ADR-0012. Do not edit any ADR.
  3. This plan.
  4. Brief AT-19 and §13.1.
  5. `docs/system-design.md`.
- **Execution profile:** autonomous, in Node and headless Chromium. Work offline, except for `git push` and `gh` at the end. Tests use mock models. Work on the existing branch `closeout2/host-export`, which holds one commit with this plan. Open one pull request against `main`. Run U1 and U2 in order, with `pnpm check` after each.
- **Stop conditions:** stop and open a draft pull request that names the blocker when any of these happens:
  - the CSP or Trusted Types policy would have to be weakened beyond allowing the download. If a `blob:` download cannot work under the existing CSP without relaxing a directive that protects scripts, stop.
  - a file under `packages/` or `examples/english-tutor` would change;
  - an existing test assertion must change. The CSP test may gain assertions only if a directive is added deliberately and documented.
  - a golden, the compatibility matrix or an ADR would change;
  - a dependency or `pnpm-lock.yaml` would change;
  - `pnpm check` still fails after three focused fix attempts on the same cause.
- **Who finishes:** the implementing agent opens the pull request and stops. It never merges.

---

## Product Contract

### Requirements

- R1. **Actions.** host-local renders two buttons beside "Start over" and "Sign out". Both are enabled only when a session exists and the page still owns it.
  - **"Export session summary"** calls `saver.exportSession(sessionId)` with no options and downloads `galaxie-session-summary.json`.
  - **"Export my answers"** first shows host-rendered text: `This file contains your answers and lesson text. Keep it private.`, with **Download** and **Cancel** buttons. Use no `window.confirm`.
    - Only **Download** calls `exportSession(sessionId, { personalContent: true })` and downloads `galaxie-session-answers.json`.
    - **Cancel** exports nothing.
  - Hand the saver and session ID to these actions through the existing host session wiring in `session.ts` and `app.tsx`. Do not use a new global.
- R2. **Download mechanics.**
  - Create a `Blob` of the JSON, then a URL with `URL.createObjectURL`, then a temporary `<a download>` click, then `URL.revokeObjectURL`.
  - Do not use `innerHTML`, and add no Trusted Types sink.
  - If the CSP blocks this, the stop condition applies. A `blob:` navigation download normally needs no CSP directive.
  - Export failures show a fixed `Export failed` alert. The alert carries no record content.
- R3. **Tests.** Extend `examples/host-local/test/loop.node.test.ts`, or add a new Playwright-driven host test following its pattern, by adding new steps or test cases.
  - After the writing prompt is submitted, click "Export session summary" and capture the Playwright `download`. The file parses, has `personalContent: false`, has no `checkpoints`, and does not contain the learner sentence.
  - Click "Export my answers", then Cancel. Assert that no download happens.
  - Click "Export my answers", then Download. The file has `personalContent: true` and contains the learner sentence.
  - Neither file contains a provider-key-shaped string or the test token.
  - The network recorder still shows no request carrying the learner sentence, because downloads are local.
  - The CSP and Trusted Types checks still pass.
- R4. **Docs.**
  - Update the host-local README section, if one exists, and `docs/guides/host-integration.md`: bind personal-content export to an explicit action.
  - Update the AT-19 row in `docs/mvp-exit-record.md` to `automated`, citing the tests, if R3 holds. Keep the note that the export is personal data once downloaded.
  - Update the AGENTS.md status paragraph in one clause.

### Scope Boundaries

- No host-remote change. host-remote uses MemorySaver.
- No import.
- No styling.

## Implementation Units

- **U1. UI and tests.** R1–R3.
- **U2. Docs.** R4.

## Verification Contract

| Gate | Command or check | Applies to |
| --- | --- | --- |
| Full local CI | `pnpm check` | every unit |
| CI-mode tests | `CI=true pnpm test` | before the PR |
| Protected paths | `git diff --stat main -- packages examples/english-tutor tests/conformance/golden tests/conformance/compatibility-matrix.json docs/adr pnpm-lock.yaml` is empty. | before the PR |

## Definition of Done

- U1 and U2 are complete.
- Personal content leaves the page only after an explicit two-step action.
- AT-19 is updated honestly.
- `pnpm check` and `CI=true pnpm test` pass, and GitHub CI is green.

## Appendix

### Sources

- `examples/host-local/src/{app.tsx,session.ts,csp.ts,trusted-types.ts}` and `test/loop.node.test.ts`.
- `packages/storage-indexeddb/README.md` (`exportSession`).
- `docs/mvp-exit-record.md` row AT-19.
