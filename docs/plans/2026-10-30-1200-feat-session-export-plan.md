---
title: Explicit Session Export Without Secrets - Plan
type: feat
date: 2026-10-30
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Explicit Session Export Without Secrets - Plan

## Goal Capsule

- **Objective:** close AT-19: "Package and session exports contain no secrets; personal content only on explicit action."
  - Package exports, meaning the generated manifest and schemas, are already scanned for the credential canary (AT-23).
  - No session export exists. `docs/unsupported.md` says "session export/sync ... not supplied".
  - Add an explicit, principal-scoped session export to `@galaxie/storage-indexeddb`. By default it holds only content-free metadata. Personal content is included only when the host passes an explicit option, which a host binds to a user action.
- **Means:**
  - an `IndexedDBSaver.exportSession()` method;
  - tests on Chromium, with a Node variant if the existing storage tests run on Node;
  - docs.
- **Authority, highest first:**
  1. `AGENTS.md`.
  2. Accepted ADRs, in particular ADR-0009 (storage) and ADR-0012. Do not edit any ADR.
  3. This plan.
  4. Brief AT-19, §12 (deletion scope, corruption) and §13.1 ("Checkpoint export: data from one session, possibly personal. It never travels with a shared package by default").
  5. `docs/system-design.md` storage sections.
- **Execution profile:** autonomous, in Node and headless Chromium. Work offline, except for `git push` and `gh` at the end. Work on the existing branch `closeout2/session-export`, which holds one commit with this plan. Open one pull request against `main`. Run U1 to U3 in order, with `pnpm check` after each.
- **Stop conditions:** stop and open a draft pull request that names the blocker when any of these happens:
  - the export would need a storage schema or format change, or a database version bump;
  - an existing test assertion must change;
  - a golden, the compatibility matrix or an ADR would change;
  - a dependency or `pnpm-lock.yaml` would change;
  - `pnpm check` still fails after three focused fix attempts on the same cause.
- **Who finishes:** the implementing agent opens the pull request and stops. It never merges.

---

## Product Contract

### Requirements

- R1. **API.** `saver.exportSession(sessionId: string, options?: { readonly personalContent?: boolean }): Promise<SessionExport>`.
  - The export is scoped to the saver's app and principal, like every other saver read. It can never read another principal's or another app's session. An unknown session rejects with the existing fixed `StorageError` code style, for example `not_found`, or a reuse of whichever existing code fits. Never include record content in an error.
  - The return value is a plain, JSON-serializable, frozen object: `{ format: 'galaxie.session-export/1', appId, sessionId, exportedAt, personalContent: boolean, metadata, checkpoints? }`.
    - `metadata` is content-free. It holds:
      - the agent identity recorded for the session;
      - the checkpoint count, and the first and last timestamps;
      - the pending-interaction count;
      - the recovery submission and effect counts, with status only;
      - the unrecoverable marker, if set.

      It holds no state values, messages, payloads, receipts' outputs or input digests' sources.
    - `checkpoints` is present only when `personalContent === true`. It holds each checkpoint's ID, parent ID and timestamp, the decoded channel values and the pending writes, in order, converted to JSON-safe values through the saver's serde. Bytes go to base64 with a marker. A value that cannot be converted is replaced by a fixed placeholder. The export never throws on such a value.
  - `personalContent` must be exactly `true` to include content. Any other value excludes it.
  - Reading checks the logout generation or fencing state the same way other reads do. Reads stay available under ownership loss, as documented. An invalidated principal exports nothing.
- R2. **No secrets.** Credentials are never stored, so the export cannot contain them. Prove it:
  - Extend or mirror the AT-23 canary run from `tests/conformance/credential-scan.test.ts`: export the session with and without `personalContent`, and scan both JSON strings for the canary.
  - Assert that a private learner sentence, as a personal-content canary, is absent from the default export and present only in the explicit export.
- R3. **Tests** in `packages/storage-indexeddb/test` and/or `tests/conformance`. Cover:
  - the default export shape and its content-free metadata;
  - the explicit export including checkpoints in order;
  - the principal and app isolation;
  - an unknown session;
  - a deleted session, after `deleteSession`;
  - an invalidated principal;
  - an unconvertible value replaced by the placeholder;
  - the frozen result.
- R4. **Docs.** Update:
  - the storage-indexeddb README and `AGENTS.md`, saying that hosts must bind `personalContent: true` to an explicit user action and must treat the export as personal data;
  - the system design storage section;
  - `docs/unsupported.md`: narrow the "session export" entry and keep sync and cross-device recovery listed;
  - the AT-19 row in `docs/mvp-exit-record.md`, with an honest status: no host UI wires the export yet, if that is the case;
  - the AGENTS.md status paragraph.

### Scope Boundaries

- No import or restore from an export.
- No host UI. A host-local button is optional and out of scope.
- No runtime-event history export.
- No core change.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Export lives in the saver.** It owns the principal-scoped records, fencing and serde. The default holds metadata only, so personal content needs an explicit opt-in, which matches §13.1.

## Implementation Units

- **U1. API and storage tests.** R1 and R3.
- **U2. Secret and personal-content scans.** R2.
- **U3. Docs.** R4.

## Verification Contract

| Gate | Command or check | Applies to |
| --- | --- | --- |
| Full local CI | `pnpm check` | every unit |
| CI-mode tests | `CI=true pnpm test` | before the PR |
| Protected paths | `git diff --stat main -- tests/conformance/golden tests/conformance/compatibility-matrix.json docs/adr pnpm-lock.yaml` is empty. | before the PR |

## Definition of Done

- U1 to U3 are complete.
- The session export exists, with content-free defaults and an explicit opt-in for content.
- AT-19 is updated honestly.
- `pnpm check` and `CI=true pnpm test` pass, and GitHub CI is green.

## Appendix

### Sources

- `packages/storage-indexeddb/src/saver.ts` (`deleteSession`, `sweep`, `invalidatePrincipal`, `#tuple`, `#pending`), `schema.ts`, `keys.ts`, `recovery.ts`, `retention.ts` and `fencing.ts`.
- `tests/conformance/credential-scan.test.ts`, `indexeddb.test.ts` and `docs/mvp-exit-record.md` row AT-19.
