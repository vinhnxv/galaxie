---
title: MVP Closeout - Package Digest, Subgraph Effects and Credential Scan - Plan
type: feat
date: 2026-10-30
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# MVP Closeout - Package Digest, Subgraph Effects and Credential Scan - Plan

## Goal Capsule

- **Objective:** close the last three partial acceptance tests in the MVP exit record that tests can close:
  - **AT-05:** the same package hash and logic run with two host bindings, without graph changes.
  - **AT-35:** a subgraph interrupt re-executes the parent node without repeating its effects.
  - **AT-23:** a scan finds no provider key in IndexedDB, traces, exports or prompts, and keys come only from the host callback.

  This slice is test evidence and docs. It adds no new runtime behavior. Where a test shows a real gap, the slice records it honestly. This is closeout slice 4 of 4.
- **Means:** Node and Chromium conformance tests, plus doc updates.
- **Authority, highest first:**
  1. `AGENTS.md`.
  2. Accepted ADRs, in particular ADR-0002, ADR-0012 and ADR-0016. Do not edit any ADR.
  3. This plan.
  4. Brief AT-05, AT-23, AT-35 and §9.
  5. `docs/system-design.md`.
- **Execution profile:** autonomous, in Node and headless Chromium. Work offline, except for `git push` and `gh` at the end. Tests use mock or injected-fetch providers and reach only loopback servers. Work on the existing branch `closeout/digest-subgraph-canary`, which holds one commit with this plan. Open one pull request against `main`. Run U1 to U4 in order, with `pnpm check` after each.
- **Stop conditions:** stop and open a draft pull request that names the blocker when any of these happens:
  - a non-test file under `packages/` or `examples/` would change;
  - an existing test assertion must change;
  - a golden, the compatibility matrix, a conformance case under `tests/conformance/cases/` or an ADR would change;
  - a dependency or `pnpm-lock.yaml` would change;
  - `pnpm check` still fails after three focused fix attempts on the same cause.

  A gap the tests reveal is not a stop condition. Record it as R3 and R6 describe.
- **Who finishes:** the implementing agent opens the pull request and stops. It never merges.

---

## Product Contract

### Requirements

**AT-05: one package, two hosts (`tests/conformance/tutor-portability.node.test.ts`)**

- R1. Prove that both hosts run the same tutor package, unchanged.
  - Both `examples/host-local` and `examples/host-remote` declare `@galaxie/example-english-tutor` as `workspace:*`. Their Vite configs alias it to the same `examples/english-tutor/src/index.ts`. Their `src/` files import the agent definition only from `@galaxie/example-english-tutor`. Neither host imports the tutor's internal paths or defines graph nodes. Check this by reading the files and the import specifiers.
  - The tutor's manifest integrity, computed in memory with the existing `scripts/build-manifest.ts` exports or verify path, without writing, is a single value for each host. That is, both hosts' builds would read one entry digest and one file inventory. If build-manifest exposes no in-memory function, compute the digest with the same algorithm the file uses. Do not change the script.
  - The bindings each host passes are different: host-local uses local bindings and host-remote uses HTTP bindings. The test shows this from each host's runtime module, for example from the bound capability names and destinations, or by creating both runtimes with mocks as the existing host runtime tests do.
- R2. If that is cheap, also run both host runtimes with mock providers against the same definition object, reusing the existing host test helpers. Assert that the graph node set is identical, read from the compiled graph or from the manifest. Skip this part if it would require changing host source.

**AT-35: subgraph re-execution and parent effects (`tests/conformance/subgraph-effects.test.ts`, Node and Chromium)**

- R3. Use a new fixture graph inside the test file. Do not change `tests/conformance/cases/`. A parent node calls one write capability through the broker, then invokes a child graph that interrupts. Run the graph through the real runtime with the LangGraph adapter, a checkpointer, `RecoveryStore` (the IndexedDB saver's `saver.recovery` on Chromium; an in-memory or fake-IndexedDB equivalent on Node, following what `recovery.test.ts` uses), and an interaction resume. Record:
  - how many times the parent node body ran, which is 2 under native LangGraph re-execution;
  - how many times the capability's host implementation was invoked.

  Then classify the result honestly:
  - **Invoked once:** the effect journal replays the receipt on re-execution. AT-35 becomes `automated`. Cite the test and state that this requires the recovery store.
  - **Invoked twice:** add the test as a passing characterization that asserts the observed count, with a comment. Record the limit in the AT-35 row and in `docs/unsupported.md`, stating that a parent node's effects before a subgraph interrupt repeat on resume, and what authors must do, such as putting effects after the interrupt or in their own node. Do not change core.

  Also run the same graph without a recovery store and record the count. This documents the difference.

**AT-23: credential canary scan (`tests/conformance/credential-scan.test.ts`, Chromium, with a Node variant where storage allows)**

- R4. Use a canary key string that appears nowhere else in the repository. A real runtime routes a role through `@galaxie/models/openai` with an injected `fetch`, and `getCredential` returns the canary. Run it with:
  - the IndexedDB checkpointer and `saver.recovery`;
  - an in-memory span exporter registered as existing tracing tests do;
  - development warnings enabled.

  After a run that reaches a pending interaction and then completes, scan for the canary:
  - every IndexedDB database the origin has, through `indexedDB.databases()`, then every object store, every record serialized;
  - every exported span, attribute and event;
  - every runtime event, snapshot, diagnostic and `ErrorInfo`;
  - the generated tutor manifest and schemas from `createManifest`, as the "exports";
  - each request body the injected `fetch` received, which holds the prompts.

  The canary may appear only in the `Authorization` header of the requests the injected `fetch` received. Assert that it does appear there, which proves the key came from the host callback.
- R5. Also cover a failing call, a 401 from the injected `fetch`, and assert that the canary is absent from the resulting error and diagnostics.

**Docs**

- R6. Update:
  - the AT-05, AT-23 and AT-35 rows in `docs/mvp-exit-record.md`, citing the new tests and setting each status honestly. Keep the existing notes: page code receives credentials, and XSS or a malicious dependency can read them (ADR-0012).
  - `docs/unsupported.md`, if R3 finds a limit;
  - `tests/conformance/README.md`;
  - the AGENTS.md status paragraph.

### Scope Boundaries

- No new deduplication mechanism in core.
- No real provider.
- No change to host or tutor source.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Characterize, don't fix, in this slice.** The closeout's job is honest evidence. If parent-effect repetition is real, it belongs to the author contract (ADR-0002: trusted agent code) and the unsupported list. A dedup redesign would need its own ADR-level decision.
- KTD2. **AT-05 hashes the source the hosts actually build.** Both Vite configs alias the tutor's source entry, so the manifest's entry digest and file inventory identify what both hosts bundle.

## Implementation Units

- **U1. AT-05 portability test.** R1–R2.
- **U2. AT-35 subgraph effects test.** R3.
- **U3. AT-23 credential scan.** R4–R5.
- **U4. Docs.** R6.

## Verification Contract

| Gate | Command or check | Applies to |
| --- | --- | --- |
| Full local CI | `pnpm check` | every unit |
| CI-mode tests | `CI=true pnpm test` | before the PR |
| No product change | `git diff --stat main -- packages examples tests/conformance/cases` is empty. | before the PR |
| Protected paths | `git diff --stat main -- tests/conformance/golden tests/conformance/compatibility-matrix.json docs/adr pnpm-lock.yaml` is empty. | before the PR |

## Definition of Done

- U1 to U4 are complete.
- The AT-05, AT-23 and AT-35 rows cite real tests with honest statuses.
- `pnpm check` and `CI=true pnpm test` pass, and GitHub CI is green.

## Appendix

### Sources

- `scripts/build-manifest.ts`, `tests/conformance/build-manifest.node.test.ts` and `manifest.node.test.ts`.
- `examples/host-local/{package.json,vite.config.ts,src/runtime.ts,test/runtime.node.test.ts}` and the matching host-remote files.
- `tests/conformance/cases/interrupt-subgraph.ts`, `recovery.test.ts` and `packages/core/src/capability-broker.ts` (`journalEffectId` keys effects by session, segment, name and ordinal).
- `tests/conformance/openai-provider.test.ts`, `models.test.ts` (AE5), `tracing.test.ts` and `indexeddb.test.ts`.
- `docs/mvp-exit-record.md` rows AT-05, AT-23 and AT-35.
