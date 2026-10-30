---
title: RAG Browser Restore After Model Removal - Plan
type: fix
date: 2026-10-30
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# RAG Browser Restore After Model Removal - Plan

## Goal Capsule

- **Objective:** After a visitor removes the downloaded embedding model in `examples/rag-browser`, a reload or a new Worker never shows a ready index or an enabled Ask button until the visitor consents again and the model files are back.
- **Means:** Prove the existing restore path with failing-first regression tests; change retrieval code only where a test exposes a gap (KTD1).
- **Authority:** This plan, then `AGENTS.md` and ADR-0012. Beads issue `galaxie-wrb` is the source report.
- **Stop conditions:** Stop and report if the fix would need a CSP or Trusted Types change, a protocol change visible to the Python executor, or a real model download.
- **Execution profile:** Small, test-first. Mock or stubbed embedder only.
- **Finishing:** Implementation by Codex CLI; Claude reviews, opens the PR and merges after CI passes.

## Product Contract

### Summary

Add regression tests showing that "Remove downloaded model" followed by a restore returns the retrieval Worker to `awaiting-consent`, keeps the cached index unused, and keeps Ask disabled. Fix the restore path only if a test fails.

### Problem Frame

A cross-model doc review of the stage 2 plan suspected that a restored cached Orama index could be marked `ready` after its embedding files were deleted, leaving Ask enabled while every query fails. A planning read of `examples/rag-browser/src/retrieval/service.ts` suggests the path is already correct: `prepare()` calls `hasModelFiles` before it reads the cached record in non-mock mode, and the `remove-model` handler drops the index and publishes `awaiting-consent`. No test exercises `remove-model` today, so the behavior is unproven and could regress.

### Requirements

**Retrieval Worker**

- R1. After `remove-model`, the current service reports `awaiting-consent`, holds no index, and rejects `search` and `paste` with the existing not-ready failure.
- R2. A new service initialized for the same app after removal, with the index record still cached and the model files missing, reports `awaiting-consent` with `restored: false` and never publishes `ready` before consent.
- R3. After consent restores verified model files, the same cached index is reused and reports `ready` with `restored: true`.

**Host page**

- R4. While the retrieval snapshot is `awaiting-consent`, the Ask button and the question flow stay disabled with the existing "Build the index before asking a question." reason, for both the JavaScript and Python executors.

### Scope Boundaries

- Mock mode skips the model-file check by design (no files exist); it is not changed.
- A second tab that already holds a loaded embedder keeps working after another tab removes the files. Its in-memory embedder stays valid until reload, and R2 covers that reload. Considered and not built: cross-tab removal broadcast. It would matter only if the in-memory embedder could fail after removal, which nothing observed shows.
- The WebLLM chat model cache and its removal are outside this bug.

## Planning Contract

### Key Technical Decisions

- KTD1. **Test first, fix only on failure.** The planning read found no defect, so the deliverable is regression proof; any code change must be the smallest one that makes a failing R1–R4 test pass, in `src/retrieval/service.ts` or `src/host/app.tsx`.
- KTD2. **Exercise non-mock mode with stubbed file checks.** Follow `examples/rag-browser/test/worker-cache.test.ts`: mock `model-files.js` so `hasModelFiles` is controllable and `downloadModelFiles` is a spy, stub `navigator.gpu`, and run in headless Chromium for real IndexedDB, Cache API and Web Locks. Also mock `embedder.js` so `createEmbedder` returns the mock embedder from `src/retrieval/mock-embedder.ts` while `verifyWebGPU` keeps its real behavior; `makeEmbedder` (`src/retrieval/service.ts:63`) calls `createEmbedder` lazily, so no ONNX load or test-only hook in `service.ts` is needed. Use a small inline corpus so the built index has a non-zero count.
- KTD3. **Host gating through the existing mock loop, without a reload step.** `test/loop.node.test.ts` drives the built page in mock mode, where `prepare()` skips the file check, so a reload there cannot show missing files; R2 in U1 owns the reload case. Ask gating is a pure function of `index.status` and `host` (`src/host/app.tsx:55-60`) with no executor input, so one check covers both executors.

### Assumptions

- `remove-model` deletes the model Cache API entry but not the IndexedDB index record (`src/retrieval/service.ts:278-291`), so the post-removal state in R2 has a cached record without any seeding.

## Implementation Units

### U1. Worker regression test for removal and restore

- **Goal:** Prove R1–R3 at the retrieval service level.
- **Requirements:** R1, R2, R3
- **Dependencies:** none
- **Files:** `examples/rag-browser/test/worker-remove-model.test.ts` (new); `examples/rag-browser/src/retrieval/service.ts` only if a scenario fails
- **Approach:** Mirror `test/worker-cache.test.ts` (KTD2). Build and persist an index with files present, send `remove-model`, then switch `hasModelFiles` to false and create a fresh `RetrievalService` for the same `appId`. Mock `embedder.js` as KTD2 states.
- **Execution note:** Write the tests first and record whether each passes before any source change.
- **Test scenarios:**
  - Files present, index built, then `remove-model`: snapshot is `awaiting-consent`, `count` 0; a following `search` emits `failed` with "The index is not ready."
  - After removal, `paste` fails the same way and writes nothing to the index cache.
  - Fresh service, same `appId`, cached record present, `hasModelFiles` false: result is `awaiting-consent` with `restored: false`, no `ready` event is emitted, and `downloadModelFiles` is not called.
  - Same fresh service, then `consent` with downloads succeeding (`hasModelFiles` false then the download spy resolves): result is `ready`, `restored: true`, and `count` equals the originally built count.
  - `remove-model` twice in a row succeeds and stays `awaiting-consent`.
- **Verification:** All scenarios pass in the headless Chromium project; the test is skipped only where IndexedDB is absent, matching `worker-cache.test.ts`.

### U2. Host Ask gating after removal

- **Goal:** Prove R4 on the page for both executors.
- **Requirements:** R4
- **Dependencies:** U1
- **Files:** `examples/rag-browser/test/loop.node.test.ts`; `examples/rag-browser/src/host/app.tsx` only if a scenario fails
- **Approach:** Add a remove step to an existing mock-mode loop test after the index is ready (KTD3).
- **Test scenarios:**
  - Index ready and models prepared, click "Remove downloaded model": the Ask button is disabled, "Build the index before asking a question." is shown, and the consent control is visible.
  - While in that state, no question request reaches the model fixture.
  - Consent again (mock mode): the page returns to a restored ready index and a question succeeds.
- **Verification:** Loop passes on its existing lanes; no CSP, Trusted Types or network-recording assertion changes.

## Verification Contract

| Check | Proves |
| --- | --- |
| `pnpm check` | Both compilers, Node and headless Chromium tests including U1 and U2, Python lane, builds, dependency and docs checks |
| `pnpm test:python` | Python executor unaffected |
| Test-first record | Codex reports whether U1/U2 scenarios failed before any source change |

## Definition of Done

- U1 and U2 tests exist and pass; any source change is limited to what a failing test required.
- If no source changed, Beads `galaxie-wrb` closes as "not reproducible; regression tests added".
- No CSP, Trusted Types, Worker protocol or ADR text changes.
- No leftover probe or abandoned-attempt code in the diff.
