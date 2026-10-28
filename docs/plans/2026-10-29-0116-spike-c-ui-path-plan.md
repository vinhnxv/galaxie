---
title: Spike C - UI Path from Interrupt to Typed Registry, with Reload - Plan
type: spike
date: 2026-10-29
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Spike C - UI Path from Interrupt to Typed Registry, with Reload - Plan

## Goal Capsule

- **Objective:** before M2 builds `packages/react`, find out whether galaxie's UI path works end to end in a real browser, and what M2's registry and M3's restore operation must provide. A learner opens a quiz that a LangGraph graph produced and paused on. The quiz is rendered from the committed interrupt through a typed registry. Stale or forged submissions never advance the graph. A reload in the middle of the quiz shows the same quiz, with the same interaction ID and content, and the answer submitted after the reload is graded. The spike ends with a recorded run, a short report and evidence in ADR-0004 and ADR-0007 (brief §16.2 row C).
- **Means:**
  - A throwaway Vite + React page under `spikes/c-ui-path/`, in its own pnpm workspace, that uses `packages/core` and `packages/adapter-langgraph` from source (KTD1, KTD2).
  - A deterministic quiz graph with no model (KTD3).
  - A small typed registry with one entry, `education.Quiz/v1` (KTD4).
  - A spike-only checkpointer that mirrors `MemorySaver` into `sessionStorage` (KTD5).
  - A spike-only restore shim around the LangGraph adapter, so the page gets a pending interaction back through core's public contracts after a reload (KTD6).
  - A Playwright script that drives the page in headless Chromium, records a video, and writes a run log (KTD7, KTD8).
- **Authority, highest first:**
  1. `AGENTS.md` repository rules.
  2. Accepted ADRs, especially ADR-0012, ADR-0015, ADR-0016 and ADR-0017.
  3. This plan. ADR-0004 and ADR-0007 are Proposed; this spike gathers their evidence.
  4. `docs/galaxie-project-brief.md` §11, §12.2, §14.1–§14.3, §16.2 and §16.4; `docs/system-design.md` §8.1 and §8.2.
- **Stop conditions:**
  - Stop and report (draft PR naming the blocker) if the page can only work by editing anything under `packages/`, `tests/` or the root workspace configuration. This spike changes no package code.
  - Stop and report if `@langchain/*` cannot be deduplicated to one copy in the Vite build (KTD2), rather than working around a duplicate copy.
  - Time box: the whole spike is one implementation session. If the reload flow through the restore shim (U4) still fails after three distinct fix attempts, each recorded with its observed error, record exactly what failed in the report, record the pre-reload evidence that did work, and open the PR. A negative result is a valid spike result.

---

## Product Contract

### Summary

Spike C answers, with observed behaviour in headless Chromium, the questions ADR-0004 and ADR-0007 defer to it:

- Can a typed registry render a `Quiz` from the pending interaction that core builds from a LangGraph interrupt?
- Does core reject stale and forged submit events without advancing the graph?
- After a reload mid-quiz, does the page show the same quiz from the committed checkpoint, without regenerating it?
- What must M2's registry and M3's restore operation provide that M1 does not?

Spike code is throwaway (brief §16.2, `AGENTS.md`). It stays under `spikes/c-ui-path/`, is never promoted to `packages/`, and its findings become requirements in the report and the ADRs.

### Problem Frame

M1 closed with a headless runtime. Its interaction contract (`PendingInteraction`, `instance.dispatch`, stale checks, URL policy) is tested only with fake executors and in-process graphs; nothing has rendered it in a page. Brief §16.4 makes Spike C the first step of M2, so that `packages/react` is built on observed behaviour rather than on the brief's sketches.

Research for this plan found one gap that shapes the spike: core cannot restore a pending interaction after a reload. Each instance gets a fresh random `sessionId` (`packages/core/src/agent-instance.ts`), `CreateOptions` has no session or instance key, and a fresh instance has no run, so every `dispatch` returns `stale`. `ExecutorAgent.pending(sessionId)` exists but core calls it only inside `dispatch`. Brief §14.1 makes restore an explicit runtime operation, and §16.5 assigns it to M3. The spike must observe reload behaviour without building that operation in core.

### Requirements

- **R1.** The page runs a real LangGraph.js graph through `createRuntime`, `createLangGraphAdapter` and `requestInteraction(request, config)` from the workspace source, in Chromium, with no server orchestration and no model.
- **R2.** The graph generates a three-question quiz and its answer key in one node, and a separate node builds the interaction request deterministically from state and pauses on it (brief §12.2). The answer key never appears in the interaction props, the snapshot, any non-`stream` event or the DOM before grading.
- **R3.** A typed registry maps `education.Quiz/v1` to a Zod props schema, an allowed-action list and a React component. The page renders only from `instance.getSnapshot().run.pending`, through one render path, before and after the reload.
- **R4.** The registry rejects an unknown component, props that fail the schema, and an action outside the entry's allowed list, each with a typed error the page displays as plain text, and renders nothing from the rejected input.
- **R5.** Every submit goes through `instance.dispatch`. Forged events that change one of `instanceId`, `runId`, `interactionId`, `surfaceId` or `viewRevision` are rejected with `stale` and leave the run `waiting_input` with the same pending interaction. Two submits in one tick produce one `accepted` receipt; the other is rejected.
- **R6.** After a reload mid-quiz (one of three questions answered in the component's local state), the page shows the same `interactionId`, `surfaceId`, `viewRevision`, component and props as before the reload, read from the committed checkpoint. The graph does not re-run the quiz-generation node.
- **R7.** After the reload, an event carrying the pre-reload `instanceId` and `runId` is rejected with `stale`. A correct submit is accepted, the graph grades it against the answer key in state, and the page shows the result.
- **R8.** The restored interaction passes core's URL check (`checkInteractionUrls` with the runtime's `urlAllowlist`) before it becomes pending again, because it re-enters through core's `interaction` event handling (KTD6).
- **R9.** A Playwright script drives the whole flow in headless Chromium, records a video, saves screenshots before and after the reload, and writes a JSON run log of every observed identifier, receipt and status. It exits non-zero if any expectation in R2–R8 fails.
- **R10.** Every request the page makes goes to the local dev server; the run log lists the request URLs.
- **R11.** A report in `spikes/c-ui-path/README.md` states what was observed, what M2's registry must take from it, and what M3's restore operation must provide.
- **R12.** ADR-0004 and ADR-0007 record the evidence in their Verification sections with a dated Revisions entry. Their Status stays Proposed; accepting them is the maintainer's decision.
- **R13.** `pnpm check` and `CI=true pnpm test` still pass, existing goldens are unchanged, and nothing under `packages/` or `tests/` changes.

### Acceptance Examples

- **AE1.** Fresh load: the page starts a run, the snapshot reaches `waiting_input`, and the Quiz renders three questions with the props from `run.pending`. The run log records `interactionId` I1, `viewRevision` and the component ID. Neither the answer-key sentinel string nor the field name `answerKey` (KTD3) appears in `run.pending.props`, the serialized snapshot, non-`stream` events or the DOM before grading. (Option texts are not checked, because the correct answers are among the rendered options.)
- **AE2.** Forged events: five dispatches, each with one identifier changed, return `{ status: 'rejected', error: { code: 'stale' } }`. After them, the snapshot still shows `waiting_input` and `pending.interactionId === I1`, and the checkpoint count recorded by the page is unchanged.
- **AE3.** Registry errors: rendering `education.Unknown/v1`, Quiz props with a missing question, and an action `'skip'` each produce a typed error string on the page, and no Quiz element is rendered for them.
- **AE4.** Reload: the learner answers question 1, then the script reloads. The page shows the Quiz again with `interactionId` I1 and identical props; question 1's local answer is gone (recorded as a finding, not a failure). The generation counter, kept in `sessionStorage` (KTD3), reads 1 after the restored Quiz renders.
- **AE5.** After reload, a dispatch with the pre-reload `instanceId`/`runId` returns `stale`. Two submits in one tick give one `accepted` and one rejected receipt. The graph grades the accepted answers and the page shows the score; the run ends `succeeded`, and the generation counter still reads 1.
- **AE6.** A restored interaction whose props carry a URL outside the allowlist fails with `denied` instead of becoming pending (the restore path keeps core's URL check). The `?variant=url` page allows `https://evil.example` on the fresh load, so the quiz becomes `waiting_input` and the thread is pinned; after the reload it uses an empty allowlist, so only the restore path can deny it. This runs in a second browser context, not in the main recording.
- **AE7.** The run log lists only `http://127.0.0.1:<port>/` request URLs.

### Scope Boundaries

- No change under `packages/`, `tests/`, root `package.json`, `pnpm-workspace.yaml`, `vitest.config.ts`, CI or Biome configuration.
- No `packages/react`; the registry is spike code.
- No IndexedDB saver, durable inbox, epoch, lock or multi-tab handling (M3). The `sessionStorage` saver is throwaway and is replaced by M3's IndexedDB saver.
- No model, model router use or Built-in AI; the quiz is deterministic.
- No CSP work (M2 example hosts own it); the page simply makes no remote requests.
- No styling beyond what keeps the page readable in the video.

#### Considered and not built

- **A core restore operation now.** It belongs to M3 with the durable inbox and the instance key (brief §14.1, §14.2, §16.5). The spike specifies it from evidence instead.
- **Re-interrupting on reload by calling `start` again.** It produces a new interaction ID, which ADR-0004 forbids.
- **Driving `ExecutorAgent` directly after a reload.** It would skip core's stale checks, URL check and snapshots, which are what the spike must observe.
- **A plain DOM registry without React.** ADR-0007 and brief §14.3 decide on React with `useSyncExternalStore`; the spike should exercise the snapshot identity contract it depends on.

### Key Decisions

- The reload path keeps core in charge of pending state through a spike-only adapter shim (KTD6), so the spike observes core's real stale and URL checks after a reload.
- Recordings: the video is committed only if it is small (KTD8); the run log and two screenshots are always committed.
- ADR Status lines stay Proposed (R12).

---

## Planning Contract

### Key Technical Decisions

- **KTD1. Spike layout.** `spikes/c-ui-path/` follows `spikes/local-english-tutor/`: its own `package.json` (`"name": "galaxie-spike-c-ui-path"`, `"private": true`, description starting "Throwaway spike:", `"license": "AGPL-3.0-only"`, `"type": "module"`, `"packageManager"` and `"engines"` copied from the tutor), its own `pnpm-workspace.yaml` (copy the tutor's, including `minimumReleaseAge: 10080`), its own `pnpm-lock.yaml`, `tsconfig.json` extending `../../tsconfig.base.json` like the tutor's, `index.html` with the HTML-comment SPDX header, and `vite.config.ts`. Every `.ts`/`.tsx` file starts with the SPDX header; Biome and the license check cover the spike, `tsc` and Vitest do not.
- **KTD2. Consuming workspace packages.** No spike has done this before. Use Vite `resolve.alias` to package source, mirroring `vitest.config.ts`: `@galaxie/core` → `../../packages/core/src/index.ts`, `@galaxie/adapter-langgraph` → `../../packages/adapter-langgraph/src/index.ts`. Add `resolve.dedupe` for `@langchain/core`, `@langchain/langgraph`, `@langchain/langgraph-checkpoint`, `zod` and `@opentelemetry/api`, so the package source and the spike's graph share one copy from the spike's `node_modules`. Mirror the aliases in `tsconfig.json` `paths`. Page code cannot see which copy the adapter resolved (its public entry exports no LangGraph classes), so the single-copy check lives in the resolver: a small spike-local Vite plugin in `vite.config.ts` records the resolved file path of every `@langchain/core`, `@langchain/langgraph` and `@langchain/langgraph-checkpoint` import, including imports from the aliased package source, and fails serve and build if any resolves outside `spikes/c-ui-path/node_modules`. The plugin's result is shown on the page and written to the run log; the stop condition applies. Also copy the `optimizeDeps.include` list from the Chromium project in `vitest.config.ts` (and add `react`, `react-dom/client` and the spike's own deep imports), so the dev server does not discover a dependency late and force-reload the page in the middle of the recorded scenario. Graph code imports only `@langchain/langgraph/web`. Do not use `link:` to `dist/` (it needs a root build and resolves a second copy).
- **KTD3. Deterministic graph.** `src/graph.ts` builds `generate → ask → grade → END` with `StateGraph` from `@langchain/langgraph/web`, compiled with `host.langchain.checkpointer()`. `generate` writes three fixed questions (each with an ID, prompt and options) to state, and the answer key under the field `answerKey` as `{ marker, answers }`, where `marker` is a fixed sentinel string that appears nowhere else (AE1 searches for it). It also increments a generation counter kept in `sessionStorage` under its own key, not in a module variable (a reload re-runs modules), which the page exposes for AE4 and AE5. `ask` builds `{ surfaceId: 'main', viewRevision: 'quiz-1', component: 'education.Quiz/v1', props: { questions } }` from state and calls `await requestInteraction(request, config)` (after an `await`, as `tests/conformance/interaction-context.test.ts` does). `grade` compares the submission's answers with the key in state and writes a score. The definition declares no models. Its input schema is a union of `{ topic: string }` and the restore marker `{ restore: true }` (KTD6), so both starts pass core's input validation; the graph never sees the marker because the shim consumes it. Follow `tests/conformance/interaction-policy.test.ts` for the real-graph runtime setup.
- **KTD4. Registry shape.** `src/registry.ts` exports a registry of entries `{ component, props: ZodSchema, actions: readonly string[], Component }` and one function that turns a `PendingInteraction` into either `{ ok: true, element }` or `{ ok: false, error: { code: 'unknown_component' | 'invalid_props', message } }`, plus a `submit(instance, pending, action, payload)` helper that rejects an action outside the entry's list with `{ code: 'invalid_action' }` before calling `instance.dispatch`. Error messages are fixed strings and never echo props. The surface maps every run status to one view: no run or `queued`/`running` → the text `Working`; `waiting_input` → the registry render; `succeeded` → the score; `failed` or `cancelled` → `Run failed: <error code>`. Each view carries a stable `data-testid` and the code in a `data-code` attribute, so the script asserts AE5, AE6 and the shim's `unsupported` path on the page. `app.tsx` creates the runtime, the instance and the fresh-or-restore start once at module scope, outside any React effect, so `StrictMode`'s double effects in dev mode cannot start a second run; components only subscribe. The Quiz component keeps answers in local React state, renders text only (no `dangerouslySetInnerHTML`), disables its submit button while a dispatch is in flight, and builds the dispatch event from the pending interaction's identifiers. `src/surface.tsx` reads `useSyncExternalStore(instance.subscribe, instance.getSnapshot)` and renders `run.pending` through the registry: this is the single render path for both fresh and restored runs.
- **KTD5. Throwaway persistence.** `src/session-saver.ts` subclasses `MemorySaver` from `@langchain/langgraph/web`. After each `put`, `putWrites` and `deleteThread` resolves, it writes `{ storage, writes }` to `sessionStorage` under one key, encoding every `Uint8Array` as base64 with `btoa`/`atob` (the shape research verified in Node). On construction it restores both fields when the key exists. The page also stores the thread ID (KTD6) under a second key. A "Reset" button clears the saver key, the thread key and the generation-counter key. The README states M3's IndexedDB saver replaces this.
- **KTD6. Restore shim.** `src/restore-adapter.ts` exports an `ExecutorAdapter` that wraps `createLangGraphAdapter()`, with the same `id`, `version` and `features`. Its `prepare` prepares the inner adapter and returns an `ExecutorAgent` that maps every `sessionId` to a pinned thread ID:
  - On a fresh page the pinned thread is unknown until the first `run`; the shim takes it from that request's `sessionId`, stores it, and passes requests through unchanged.
  - On a restored page the pinned thread comes from `sessionStorage`. `pending(sessionId)` returns `inner.pending(pinnedThread)`. `run(request)` forwards with `sessionId: pinnedThread`, except for a `start` command whose input is the spike's restore marker (`{ restore: true }`): then it yields exactly one `{ type: 'interaction', interaction }` event built from `inner.pending(pinnedThread)` and ends, without running the graph. If nothing is pending, it yields an `error` event with `unsupported`, as brief §14.1 requires instead of silently starting over.
  - Core therefore handles the restored interaction as any other: it checks executor features, the inbox and the URL allowlist, sets `waiting_input`, and builds `run.pending`; later `dispatch` re-reads `pending(sessionId)` through the shim and resumes the pinned thread. The new run has a new `runId`; `interactionId` stays the engine's.
  - The shim is the spike's model of M3's restore operation. Its file header comment says so and says it must not be copied into packages.
- **KTD7. Driving and recording.** `scripts/record.ts` (run with `node`, which strips types on Node 24) starts Vite programmatically with `createServer` on `127.0.0.1` and a fixed port, launches Playwright Chromium headless with `recordVideo` (viewport 800×600), and runs the scenario through the visible UI and a small `window.spikeC` test handle the page exposes only in dev mode. The handle offers `snapshot()`, `dispatch(event)` (raw core dispatch, for forged events), `submit(action, payload)` (calls the registry's `submit` helper with the current `run.pending`, so AE3's `'skip'` probe is rejected with `invalid_action` and never reaches core), `renderProbe(pending)` (registry render check for AE3 without dispatch), `counters()` (generation runs, checkpoint count) and `singleCopy()` (KTD2's plugin result). Request URLs are observed from Playwright's `page.on('request')`, not from the page. The same-tick double submit is two synchronous `window.spikeC.dispatch` calls with the same correct event; the log records both receipts. Separately, the script double-clicks the real submit button once on a throwaway check and logs how many dispatches reached core, so the report can say whether core or the component guard stopped the second one. The script runs every AE even after one fails (a step that depends on a failed one is logged as `skipped` with the reason), logs each result with its observed values, writes `results/run-log.json`, `results/before-reload.png` and `results/after-reload.png`, closes everything, and exits non-zero at the end if any AE failed or was skipped. AE6 runs in a second browser context against `?variant=url` (a graph whose quiz props include `https://evil.example/x`; allowlist as AE6 describes) and is logged separately.
- **KTD8. What gets committed.** `results/run-log.json` and the two PNGs are committed. The video goes to `recordings/` (git-ignored by a spike-local `.gitignore` with `recordings/` and `node_modules/`); if the `.webm` is at most 3 MB it is also copied to `results/run.webm` and committed, otherwise the README says where to regenerate it. The run log contains identifiers, statuses, receipt codes, counters and request URLs only: no answer-key values, no props bodies.
- **KTD9. Dependencies.** All inside the spike, exact versions that the tutor spike's or the root lockfile already resolve (so they pass the release-age gate): `react` and `react-dom` 19.3.1, `@langchain/core` 1.2.20, `@langchain/langgraph` 1.5.1, `zod` 4.6.7, `@opentelemetry/api` 1.10.0; dev: `vite` 8.3.4, `@vitejs/plugin-react` 6.1.2, `@types/react` and `@types/react-dom` 19.3.0, `playwright` 1.64.1, `typescript` at the root's exact version. If any version cannot install under the 7-day gate, use the newest version the gate allows and record the change; never lower the gate. `@galaxie/*` are aliases, not dependencies.

### High-Level Technical Design

Directional sketch, not implementation:

```text
fresh load
  runtime(createRuntime, executors:[restoreAdapter(langgraph)], urlAllowlist:[])
  instance.prepare(); instance.start({ topic })        -> shim pins thread = sessionId
  graph: generate -> ask(requestInteraction) -- pause; SessionSaver mirrors to sessionStorage
  core: interaction event -> URL check -> waiting_input, run.pending
  <Surface> -> registry('education.Quiz/v1') -> zod parse -> <Quiz props>
  forged dispatches -> stale; double submit -> one accepted   (or: answer q1, then reload)

reload
  SessionSaver restores storage; shim pins stored thread
  new instance (new instanceId, sessionId); instance.start({ restore: true })
  shim: start+marker -> yield { interaction: inner.pending(thread) }  (graph not run)
  core: URL check -> waiting_input, run.pending (same interactionId, new runId)
  <Surface> renders the same Quiz; old-identity dispatch -> stale
  submit -> core dispatch -> shim.pending(thread) matches -> resume thread -> grade -> output
```

### Assumptions

- Core accepts an `interaction` event as the first and only event of a start segment from an executor whose features include interrupts: `acceptEvent` sets the segment outcome to `waiting_input`, so the drain loop in `packages/core/src/agent-instance.ts` ends without a protocol violation when the iterator finishes. If the page observes otherwise, record the exact failure in the report as a finding for M3 and stop U4 under the time box.
- Vite `resolve.dedupe` with aliases to TypeScript source gives one copy of `@langchain/*`; KTD2's startup assertion verifies it.
- The answer to "does local input state survive a reload" is expected to be no; that is a finding for M2, not a defect to fix in the spike.

### Implementation Constraints

- `AGENTS.md` rules: English only; SPDX header on every new source file; never describe galaxie as secure, compliant, certified or production-ready; no secrets; never weaken a check.
- Stage files by name; never commit `spikes/.DS_Store`, `node_modules/` or `recordings/`.
- The spike must not import from `packages/*/dist` or modify anything outside `spikes/c-ui-path/`, `docs/adr/0004-interrupt-as-pending-interaction-source.md`, `docs/adr/0007-typed-ui-registry-for-mvp.md`, `docs/system-design.md`, `docs/galaxie-project-brief.md` and this plan.
- Biome must pass on the spike files (2-space indent, single quotes, line width 100).

### Sequencing

U1 → U2 → U3 → U4 → U5 → U6. U4 depends on U2's saver and U3's surface. U5 needs U3 and U4 in place. U6 needs U5's results.

---

## Implementation Units

### U1. Spike workspace and package wiring

**Goal:** an empty page that loads `@galaxie/core` and `@galaxie/adapter-langgraph` from source with one copy of LangGraph.

**Requirements:** R1, R13.

**Dependencies:** none.

**Files:**
- `spikes/c-ui-path/package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tsconfig.json`, `vite.config.ts`, `index.html`, `.gitignore`
- `spikes/c-ui-path/src/main.tsx`

**Approach:** follow KTD1, KTD2 and KTD9. `main.tsx` renders a heading and the single-copy check result.

**Patterns to follow:** `spikes/local-english-tutor/` (workspace, tsconfig, Vite, README layout); `vitest.config.ts` aliases.

**Test scenarios:**
- `pnpm --dir spikes/c-ui-path install --frozen-lockfile` succeeds after the lockfile is committed.
- `pnpm --dir spikes/c-ui-path exec vite build` succeeds.
- `pnpm exec tsc -p spikes/c-ui-path/tsconfig.json --noEmit` from the repo root succeeds (local check; not in CI).
- The page shows the single-copy check as passing.

**Verification:** the three commands pass and Biome/license checks pass on the new files.

### U2. Quiz graph and throwaway saver

**Goal:** a deterministic graph that pauses on a Quiz request, with checkpoints mirrored to `sessionStorage`.

**Requirements:** R1, R2.

**Dependencies:** U1.

**Files:**
- `spikes/c-ui-path/src/graph.ts`
- `spikes/c-ui-path/src/session-saver.ts`

**Approach:** KTD3 and KTD5. The `?variant=url` graph differs only in one question's prompt text, which is `https://evil.example/x`.

**Patterns to follow:** `tests/conformance/interaction-policy.test.ts` real-graph case; `tests/conformance/interaction-context.test.ts`.

**Test scenarios:** exercised by U5's script: AE1 (pause and props), AE4 (counter stays 1), the saver round trip across a reload.

**Verification:** covered by U5.

### U3. Typed registry, Quiz component and surface

**Goal:** the single render path from `run.pending` to a React element, with typed rejection.

**Requirements:** R3, R4, R5.

**Dependencies:** U1.

**Files:**
- `spikes/c-ui-path/src/registry.ts`
- `spikes/c-ui-path/src/quiz.tsx`
- `spikes/c-ui-path/src/surface.tsx`
- `spikes/c-ui-path/src/app.tsx` (runtime setup, Reset button, result view, dev-only `window.spikeC` handle)

**Approach:** KTD4. `app.tsx` creates the runtime at module scope with `urlAllowlist: []` (except the AE6 variant's fresh load) and the restore adapter (U4; until U4 lands, the plain LangGraph adapter). The result view renders the score from the run's `output` event as text.

**Patterns to follow:** brief §14.3's `useAgentSnapshot`/`AgentSurface` sketch; `packages/core/src/instance.ts` (`getSnapshot` stable identity, `subscribe`).

**Test scenarios:** exercised by U5: AE1, AE2, AE3, and the double submit in AE5.

**Verification:** covered by U5.

### U4. Restore shim and reload

**Goal:** after a reload, the same pending Quiz comes back through core.

**Requirements:** R6, R7, R8.

**Dependencies:** U2, U3.

**Files:**
- `spikes/c-ui-path/src/restore-adapter.ts`
- `spikes/c-ui-path/src/app.tsx` (choose `start(input)` or `start({ restore: true })` by whether a pinned thread exists)

**Approach:** KTD6. The page shows `Restored` or `Fresh` and the current `runId` so the video shows which path ran.

**Patterns to follow:** `packages/core/src/executor.ts` (`ExecutorAdapter`, `ExecutorAgent`, `RunRequest`); `packages/adapter-langgraph/src/adapter.ts` (`pending`, resume command).

**Test scenarios:** exercised by U5: AE4, AE5, AE6.

**Verification:** covered by U5.

### U5. Recorded run

**Goal:** one command produces the evidence.

**Requirements:** R9, R10.

**Dependencies:** U3, U4.

**Files:**
- `spikes/c-ui-path/scripts/record.ts`
- `spikes/c-ui-path/results/run-log.json`, `results/before-reload.png`, `results/after-reload.png`, and `results/run.webm` if at most 3 MB (generated, then committed)

**Approach:** KTD7 and KTD8. `package.json` scripts: `"start": "vite"`, `"record": "node scripts/record.ts"`. Scenario order: fresh load (AE1) → registry probes through `renderProbe` and `submit` (AE3; assert the run is still `waiting_input` with I1 pending) → forged dispatches (AE2) → answer question 1 → screenshot → reload → restored Quiz (AE4) → screenshot → old-identity dispatch and double submit (AE5) → result → request audit (AE7); then the `?variant=url` context (AE6).

**Test scenarios:** AE1–AE7 as assertions in the script, each logged with pass/fail.

**Verification:** `pnpm --dir spikes/c-ui-path record` exits 0 and every AE is logged as passing, or, under the time box, the failing AE and its observed values are logged and reported.

### U6. Report, ADR evidence and doc touch-ups

**Goal:** the findings are written down where M2 and M3 will read them.

**Requirements:** R11, R12, R13.

**Dependencies:** U5.

**Files:**
- `spikes/c-ui-path/README.md`
- `docs/adr/0004-interrupt-as-pending-interaction-source.md`
- `docs/adr/0007-typed-ui-registry-for-mvp.md`
- `docs/system-design.md` (§1 spike list; §11 Spike C row status)
- `docs/galaxie-project-brief.md` (§16.2 "Two spikes ran" sentence)

**Approach:**
1. README in the tutor's layout: title "Spike C: UI path", the throwaway notice, **Run it**, **What the page does**, **Results** (date, Chromium version from Playwright, exact package versions, an AE table from the run log), **Findings for M2**, **Findings for M3**, **Limits**. Split reload results into two lists: *observed* (the interaction ID and props read back from the deserialized checkpoint, the saver round trip, `generate` not re-run on the resume, core's stale, duplicate and URL checks applied to the shim's event) and *determined by the shim design* (the new `runId`, rejection of the old `instanceId`/`runId`, the graph not running on restore). Findings to cover:
   - Limits must also state that the answer key sits in the `sessionStorage` checkpoint and in `values` stream events that page code can read, so R2 shows only that the key stays out of props, snapshots and the DOM, not that client-side grading cannot be inspected.
   - M2 registry: the action allowlist lives in the registry today because `dispatch` accepts any non-empty action; whether core should check actions against `UiRequirements` or the registry; that `parseInteractionRequest` accepts exactly four keys, so actions must not travel in the interrupt value (brief §11.3's example differs); local input state lost on reload and whether M2 needs a draft store; URL props should be declared in the props schema and checked with `isAllowedUrl`; `UiRequirements` is not read by the runtime.
   - M3 restore operation: the minimal API the shim modelled (a stable instance or session key in `CreateOptions`, an explicit restore call that reads `executor.pending`, applies the URL check and creates a `waiting_input` run, and returns `unsupported` when nothing is pending); an open question, not a finding: whether restore continues the pre-reload run (same `runId`, labels, budgets, inbox) or creates a new run bound to the restored interaction, since the shim chose a new run by construction; that the spike carried no labels, grants, consumed budget or submitted text, so M3's restore operation must define how run labels (ADR-0014), budget usage and grants carry over; that the in-memory inbox and the `sessionStorage` saver are replaced by M3's IndexedDB saver and durable inbox.
2. ADR-0004 and ADR-0007: append a dated "Spike C (2026-10-29, `spikes/c-ui-path/`)" bullet to Verification with the observed facts and a link to the README; replace the "Spike C, before M2" placeholder lines with that evidence; add a dated Revisions entry. Status stays Proposed. The ADR-0007 bullet must say that the spike registry did not apply the URL allowlist itself (AE6 covered only core's `checkInteractionUrls` on the restore path), so a schema-declared URL check in the registry remains unverified for M2.
3. System design §1 and brief §16.2: three spikes have run; keep the text factual.

**Patterns to follow:** `docs/adr/0006-model-providers-and-routing.md` (spike evidence bullet); `spikes/local-english-tutor/README.md`.

**Test scenarios:** `pnpm check` passes; links in the README and ADRs resolve to existing files.

**Verification:** `grep -rn "Two spikes ran\|two throwaway spikes" docs/` returns nothing stale.

---

## Verification Contract

- `pnpm --dir spikes/c-ui-path install --frozen-lockfile`, `pnpm --dir spikes/c-ui-path exec vite build` and `pnpm exec tsc -p spikes/c-ui-path/tsconfig.json --noEmit` pass.
- `pnpm --dir spikes/c-ui-path record` exits 0 with AE1–AE7 logged as passing (or the time-box path in the Goal Capsule is followed and reported).
- `pnpm check` and `CI=true pnpm test` pass at the repo root.
- `git diff main --stat -- packages tests pnpm-workspace.yaml package.json vitest.config.ts biome.json .github` is empty, and `git diff main -- tests/conformance/golden` is empty.
- `git ls-files spikes/c-ui-path` shows no `node_modules`, `recordings` or `.DS_Store`.

## Definition of Done

- U1–U6 are committed on branch `spike/c-ui-path` with English messages.
- The Verification Contract passes.
- A ready-for-review PR against `main` lists the AE results from the run log, the findings for M2 and M3, the committed evidence files, and every departure from this plan.
- No Beads IDs, `internal/` content or secrets appear in tracked files, commits or the PR.
