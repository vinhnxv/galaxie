# Spike C: UI path

Throwaway spike (brief §16.2). Nothing here becomes package code. It exercises a deterministic LangGraph quiz through the workspace runtime and adapter in Chromium, a typed React registry, and a session checkpoint mirror with a spike-only restore shim. No model, exporter or remote service is used.

## Run it

Node.js 24 and pnpm 11. This directory is an independent workspace with exact dependency versions and a seven-day minimum release age.

```sh
pnpm --dir spikes/c-ui-path install --frozen-lockfile
pnpm --dir spikes/c-ui-path start
# Open http://127.0.0.1:4176/; Reset starts a fresh quiz.
pnpm --dir spikes/c-ui-path record
```

The recording command starts its own server on port 4176 and drives headless Chromium. Install that Playwright version's Chromium with `pnpm --dir spikes/c-ui-path exec playwright install chromium` if it is absent. The command writes a JSON log, two screenshots and a video. Raw videos stay in ignored `recordings/`; a video at most 3 MB is copied to `results/run.webm`.

## What the page does

- `generate → ask → grade` commits three fixed questions and a grading key in separate state fields. After an await, `ask` builds the four-field interaction and calls `requestInteraction(request, config)`.
- The only quiz surface reads `instance.getSnapshot().run.pending` through `useSyncExternalStore`, validates props with Zod and renders the registry's trusted React component. Questions and options are text, with native radio labels and fieldsets.
- Every submit goes through core dispatch. The registry permits only `submit`; core checks interaction identity and deduplicates submissions. A synchronous component guard and a disabled button cover in-flight UI submission.
- A `MemorySaver` subclass mirrors serialized storage and pending writes into `sessionStorage`, including base64-encoded bytes. The shim pins the original thread across new runtime instances, re-emits its committed interrupt on restore, and leaves URL validation and pending state to core.
- The resolver audits physical LangChain imports during dependency prebundling and builds, including imports from aliased package source; the page and run log show the result. All audited files resolve inside this spike's `node_modules`.
- Reset clears the saver, thread and generation keys. Reload after grading displays `Run failed: unsupported` rather than starting another quiz.

## Results

Recorded on 2026-10-29 (Asia/Ho_Chi_Minh), Chromium 156.0.8078.4, headless Playwright, 800×600. Node.js 24.15.0; pnpm 11.21.0. These observations cover one machine and this deterministic graph.

| Example | Result | Observation |
| --- | --- | --- |
| AE1 | passed | Three questions from pending; no key marker or field in props, snapshots, non-stream events or DOM. |
| AE2 | passed | Five forged identities returned stale; waiting interaction and three checkpoints unchanged. |
| AE3 | passed | Unknown component, missing question and skip action rejected with typed errors; skip sent no core dispatch. |
| AE4 | passed | Identical pending interaction and props after reload; local answer lost; generation count 1. |
| AE5 | passed | Old identity stale; simultaneous submits accepted/duplicate; score 3/3; succeeded; generation count 1. |
| AE6 | passed | URL allowed fresh, denied on restore with no pending interaction. |
| AE7 | passed | All observed page requests used the local Vite origin; no browser errors. |

The separate real-button double-click probe sent **one** dispatch to core, so the UI guard prevented a second dispatch in that probe. The direct same-tick probe reached core twice and demonstrated its `duplicate` rejection. Reload after consuming the checkpoint returned `unsupported`.

Evidence: [run log](results/run-log.json), [before reload](results/before-reload.png), [after reload](results/after-reload.png), [video](results/run.webm). The committed video is 76124 bytes. The log stores comparison booleans rather than props bodies or grading-key values. The rendered option texts are intentionally visible; the exposure check searches the unique marker and field name rather than correct-answer option text.

| Package | Exact version |
| --- | --- |
| `react` | 19.3.1 |
| `react-dom` | 19.3.1 |
| `@langchain/core` | 1.2.20 |
| `@langchain/langgraph` | 1.5.1 |
| `zod` | 4.6.7 |
| `@opentelemetry/api` | 1.10.0 |
| `vite` | 8.3.4 |
| `@vitejs/plugin-react` | 6.1.2 |
| `@types/react` | 19.3.0 |
| `@types/react-dom` | 19.3.0 |
| `playwright` | 1.64.1 |
| `typescript` | 7.0.2 |

Reload observations:

- The pending interaction's ID, surface, revision, component and props matched after deserializing the saver and reading the checkpoint through the adapter. No separate pending projection was persisted.
- The saver round trip retained three checkpoints; generation stayed at 1 across restore and resume. Grading completed with five checkpoints.
- Core applied stale-event, duplicate and URL checks to the shim's restored interaction. The deny variant first reached `waiting_input` with the URL origin allowed, then failed with `denied` under an empty allowlist after reload.
- One local radio answer was lost on reload.

Determined by the shim design:

- Restore creates a new instance and run, so both IDs change and events with the old pair are stale.
- The graph does not execute during restore: the shim reads `pending` and emits one interaction event. The generation counter independently confirms it was not regenerated on resume.

## Findings for M2

- A registry entry can own the component ID, props schema, action allowlist and trusted React component. Stable snapshot identity supports `useSyncExternalStore` before and after reload without a separate renderer.
- The registry owns action validation today because core dispatch accepts any non-empty action. M2 must decide whether core should also check actions against `UiRequirements` or registry metadata. The runtime does not read `UiRequirements` today.
- `parseInteractionRequest` accepts exactly four keys. Actions cannot travel in the interrupt value; brief §11.3's illustrative payload differs from the implemented contract.
- Local input state is lost on reload. M2 must decide whether to provide a draft store and how it is bound to interaction identity.
- URL props should be declared in schemas and checked with `isAllowedUrl`. This spike's registry does not apply the URL allowlist: AE6 verifies only core's `checkInteractionUrls` on restore, so the registry URL policy remains unverified.
- The current adapter turns the last raw `values` chunk into a journaled output. The spike wrapper projects that event to the public score so the grading key stays out of non-stream output. A host must define its public projection rather than assume graph state is display data.

## Findings for M3

- The shim models a minimal restore API: a stable instance or session key in `CreateOptions`; an explicit operation that reads `executor.pending`, applies URL policy and creates a `waiting_input` run; and `unsupported` if nothing is pending. It is evidence for the API, not that API's implementation.
- Open question: should restore continue the previous run, preserving its ID, labels, budgets and inbox, or create a new run bound to the restored interaction? This spike chose a new run by construction; it does not decide the question.
- The spike carried no labels, grants, consumed budget or submitted text across reload. M3 must define how labels (ADR-0014), budget usage and grants carry over.
- M3 replaces this `sessionStorage` mirror with the IndexedDB saver and replaces the in-memory submission inbox with the durable inbox. Atomic owner checks, replay after acceptance and checkpoint-confirmed consumption remain to be tested there.

## Limits

The grading key sits in historical `sessionStorage` checkpoints and in raw `values` stream events that page code can read. R2 establishes separation from props, snapshots, non-stream events and the DOM, not that client-side grading cannot be inspected. Authoritative grades need a host-controlled server.

This is a single-tab reload demonstration, with no crash injection, IndexedDB, durable inbox, multi-tab locking, epoch, model, grants, labels or consumed-budget recovery. It does not establish exactly-once side effects. The URL variant renders a URL as text and never fetches it. The registry's schema-declared URL validation remains M2 work.

## Departures from the plan

- Omitted the Chromium conformance prebundle entry `@opentelemetry/sdk-trace`: this spike has no exporter dependency and Vite could not resolve that test-only entry. All actual deep imports are prebundled. No dependency version or release-age gate changed.
- Added score-only projection of the adapter's final output in the spike wrapper. Inspection showed that its last `values` chunk otherwise journals the whole graph state, including the grading key.
- The single-copy audit also runs in Vite's dependency optimizer and forces optimization at startup. A page resolver alone sees generated chunks rather than their physical transitive imports; this records the actual LangChain/checkpoint paths on every run. The first optimizer integration treated scan externals and not-yet-written chunks as files and failed; the final hook audits physical imports and leaves those generated/scanner entries to Vite. All acceptance checks then passed unchanged.
- Added the recording script to the spike TypeScript check and exposed a dev-only serialized exposure probe to assert that snapshots and non-stream events exclude grading data. Neither is emitted into the run log.
- The request audit is finalized after every browser context, including AE6, so it covers the complete run.

The reviewed plan is unchanged. No implementation file under `packages/` or `tests/` was modified.
