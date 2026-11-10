# Static breakpoints and ID-less interrupts

This throwaway Node workspace measures LangGraph.js 1.5.1 compile-time breakpoints and interrupts without IDs, then exercises a candidate executor through unmodified core. It uses scripted graphs, no model and no network call. The executor is not shipped and must not be copied into packages.

Run from the repository root:

```sh
pnpm --dir spikes/static-breakpoints install --frozen-lockfile
pnpm --dir spikes/static-breakpoints typecheck
pnpm --dir spikes/static-breakpoints exec vitest run test/native.test.ts
pnpm --dir spikes/static-breakpoints exec vitest run test/langgraph-core.test.ts
pnpm --dir spikes/static-breakpoints test
pnpm exec biome format --write spikes/static-breakpoints/results
shasum -a 256 spikes/static-breakpoints/results/*.json
```

Run the last three commands twice: the formatted evidence must be byte-identical. UUID/hash IDs are normalized to first-appearance labels within each observation. Use `exec vitest run <file>` for focused runs; pnpm 11's `test -- <file>` can select sibling tests. The spike has its own workspace and lock, so root install and CI do not install or run it.

## Results

Recorded on 2026-11-10 with Node v24.15.0 and pnpm 11.21.0, on the maintainer's macOS host. These are deterministic scripted observations, not device performance measurements.

| Package | Exact version |
| --- | --- |
| @langchain/langgraph | 1.5.1 |
| @langchain/langgraph-checkpoint | 1.2.0 |
| @langchain/core | 1.2.20 |
| @opentelemetry/api | 1.10.0 |
| zod | 4.6.7 |
| vitest | 5.0.5 |
| typescript | 7.0.2 |
| @types/node | 24.19.2 |

| Gap | Outcome | Deciding evidence | Follow-up |
| --- | --- | --- | --- |
| Static breakpoints | **alternative** | CS3 and CS6-reject fail the durable-reject requirement in all modes; CR1 passes in all modes. | Document gate-node replacement for static breakpoints and refuse compiled breakpoints at prepare in the LangGraph adapter |
| ID-less interrupts | **supported** | I4 reaches an ID-less requestInteraction call; I5, I6 and CI2 pass in all modes. Only one top-level pending call qualifies; NodeInterrupt and raw GraphInterrupt remain refused (I2, I3, CI1). | Support ID-less LangGraph interrupts raised through interrupt() with synthesized interaction IDs |

Supported means design proven, implementation pending review. Both gaps remain unsupported in the shipped adapter. This spike adds no conformance case, golden or matrix entry.

The outcome rule was fixed before the final evidence run: static support requires every critical before/continue/reject/restore/crash/refusal/content probe in every mode, with unproven other shapes explicitly refused. Otherwise a passing gate replacement gives alternative; otherwise refused. ID-less support requires a requestInteraction-reachable missing-ID call and passing native resume, stable identity and core restore in every mode. Otherwise ordinary ID-bearing calls plus the requestInteraction replacement can establish alternative; otherwise refused. Unmeasured critical probes cannot establish support. Passing tests reproduce the observations, including design failures recorded as `pass: false`.

## Author guidance

Replace compile-time breakpoints with an explicit gate node using `requestInteraction(request, config)`, before the node that does the work (CR1). Put the gate in its own node, keep its prefix deterministic and side-effect free, and route its answer through a conditional edge: `continue` goes to work; `reject` goes to `END`. Both actions can have a null payload. A gate after a node replaces an after-breakpoint. This changes graph topology and has no native compile-time toggle. The measured fixture places its gate before work, not after finish.

Replace `NodeInterrupt` and manually thrown `GraphInterrupt` with `requestInteraction` or `requestSurface`, passing the complete node config (CR2 and the shipped [interaction guidance](../../packages/adapter-langgraph/AGENTS.md#do)). Ordinary calls already carry IDs, including Send targets and compiled child graphs (I1). Do not strip checkpoint namespaces: the deliberately stripped-config fixture establishes feasibility of a missing-ID fallback, not a recommended author pattern. The existing [interrupt-sequence case](../../tests/conformance/cases/interrupt-sequence.ts) demonstrates the shipped one-request-per-node path.

## Native probes

Machine observations: [results/native.json](results/native.json).

| Probe | sync | async | exit | Observation |
| --- | --- | --- | --- | --- |
| I1 | pass | pass | pass | Ordinary requestInteraction calls in top-level, Send and compiled-child fixtures carry string IDs. |
| I2 | fail | fail | fail | NodeInterrupt has no ID; bare resume reruns and throws again (two executions). |
| I3 | fail | fail | fail | Raw GraphInterrupt with a request has no ID; bare resume reruns and throws again. |
| I4 | pass | pass | pass | A RunnableLambda invoking requestInteraction with checkpoint_ns removed reaches an ID-less interrupt. |
| I5 | pass | pass | pass | A bare answer reaches the single call and completes (two body executions); with two pending ID-less Send tasks, both receive the same answer. |
| I6 | pass | pass | pass | The single pending task ID and ordinal zero are stable across ten reads and saver reopen. |
| S1 | pass | pass | pass | Before pause: empty interrupt update, pending work task, no task error. |
| S2 | pass | pass | fail | Finished node from retained parent tasks in sync/async; exit retains no parent. Metadata has no writes; a versions-seen difference is not proven. |
| S3 | pass | pass | pass | Null invoke and transform continue once; empty Command throws EmptyInputError; bare resume without an interrupt also continues. |
| S4 | pass | pass | pass | Ten reads and a reopened/reversed saver preserve identity; loop visits have distinct checkpoints. |
| S5 | pass | pass | pass | Continue removes the old pause; a loop pauses at the next visit. |
| S6-fanoutBoth | pass | pass | pass | Two matching tasks; native continue runs both once. Candidate executor refuses this shape. |
| S6-fanoutOne | pass | pass | pass | One matching task plus an unlisted sibling; native continue runs both once. |
| S7 | pass | pass | pass | Wildcard pauses before prepare; hidden-tag exclusion is not measured. |
| S8 | pass | pass | pass | Static-before gate followed by an ID-bearing dynamic pause and ID-map resume. |
| S9 | pass | pass | pass | Failed native task has an error and nonempty next; it is distinguishable from a breakpoint. |
| S10 | fail | fail | fail | Native parent resume runs the child once, but nested checkpoint identity/discovery is not verified; candidate refuses children. |
| S11 | pass | pass | pass | Before-pause, continue, identity and reopened-saver observations hold in each durability mode. |
| S12 | fail | fail | fail | Runtime interruptBefore works but is invisible in compiled properties; it cannot be classified this way. |

## Core proofs

Machine observations: [results/core.json](results/core.json), section `C`. Every core proof uses the real runtime, dispatch, inbox and recovery paths. The saver is deep-cloned into a fresh MemorySaver, optionally returning writes in reverse order; it is not IndexedDB.

| Probe | sync | async | exit | Observation |
| --- | --- | --- | --- | --- |
| CI1 | pass | pass | pass | NodeInterrupt/raw GraphInterrupt and two missing-ID pauses fail unsupported without publishing an unanswerable pause. |
| CI2 | pass | pass | pass | Single missing-ID requestInteraction: synthesized identity, bare resume, restore and crash windows pass through unmodified core. |
| CR1 | pass | pass | pass | Explicit requestInteraction gate: continue/reject, reload and all crash windows advance durably; reject routes to END without work. |
| CR2 | pass | pass | pass | An ordinary ID-bearing requestInteraction replaces NodeInterrupt and publishes/resumes/restores. |
| CS1 | pass | pass | pass | Bounded synthesized request, checkpoint identity and native live values/updates. |
| CS2 | pass | pass | pass | Continue runs prepare/work/finish once and matches an uninterrupted native result. |
| CS3 | fail | fail | fail | Reject fails denied live, but leaves the checkpoint pause and accepted inbox entry. Recovery replays reject; restore without an inbox republishes it. A later start runs prepare again. |
| CS4 | fail | fail | fail | After breakpoints are refused; no cross-mode finished-node classifier is implemented. |
| CS5 | pass | pass | pass | Pending identity/props survive reload; old run is stale, accepted restored answer is deduplicated. |
| CS6-continue | pass | pass | pass | Before-resume, after-commit and no-fault windows apply continue once and consume the inbox. |
| CS6-reject | fail | fail | fail | Every window leaves the checkpoint pending and inbox accepted; recovery repeats denied. There is no reject checkpoint commit. |
| CS7 | pass | pass | pass | Wrong identity is stale; unknown action and non-null payload invalid; repeated answer duplicate. |
| CS8 | pass | pass | pass | Two matching tasks, child pause and failed task publish no pause and end unsupported. |
| CS9 | pass | pass | pass | Two loop visits publish distinct IDs; the earlier answer remains duplicate. |
| CS10 | pass | pass | pass | Private state stays out of pending/snapshot/interaction records; raw live streams and unprojected output still contain it. Markup/long names fail unsupported; URL names are rejected by LangGraph before compilation. |
| CS11 | pass | pass | pass | Continue does not approve a write; a separate single-use confirmation is required. |
| CS12 | pass | pass | pass | Committed resume values register before pending returns; a missing hook fails unsupported. This probe inserts a resume write to isolate the hook. |

## Where native behavior cannot be matched

- There is no native reject. The static candidate emits `denied` without writing a checkpoint. With recovery, the inbox stays accepted and restore replays the reject; without that inbox, the same checkpoint republishes the breakpoint. No durable reject marker is proven. This is why static breakpoints have the alternative outcome, despite successful continue and restore probes.
- `interruptAfter` lacks a proven finished-node classifier across modes. The basic retained parent names prepare in sync/async, but exit retains no parent; metadata has no writes. The versions-seen map is recorded, but deriving a unique finished node from it is not proven. The candidate refuses the after kind, including the combined before/after fixture.
- Host-supplied runtime `interruptBefore`/`interruptAfter` overrides are invisible to a compiled-property read. Only the before override is measured (S12).
- State editing at a breakpoint (`updateState`, update/goto Commands) is outside this mapping. Continue uses native null input, not an approval or a state rewrite.
- Child checkpoint discovery is not proven; the candidate declares `subgraphs: false` and refuses child pauses. S10 observes native child continuation only.
- Two matching tasks or multiple dynamic interrupts are refused, rather than exposing one answer that may hide another. A single listed static task beside an unlisted sibling is observed natively; null continue also runs that sibling.
- An aborted checkpoint can resemble a static breakpoint in the proposed checkpoint-only classification. The abort window is not measured here, so cancellation/restore cannot be claimed as supported.
- Wildcard hidden-tag exclusion is unmeasured. Ordinary wildcard before-prepare behavior alone does not establish wildcard support.
- The ID-less design covers the single top-level stripped-namespace requestInteraction fixture and ordinal zero only. Repeated ID-less calls and child namespaces are not proven; a parallel bare answer reaches both tasks (I5), so selective parallel routing is refused (CI1). NodeInterrupt and raw GraphInterrupt always throw again and remain refused.
- Raw graph streams retain state and are delivered live, without replay. The private canary stays out of the synthesized request and snapshot, but is present in live streams and unprojected output (CS10). Hosts must project display output and never render raw streams. This is the existing stream boundary, not a new content filter.

## Not measured

- S9b and CS8b: cancellation between supersteps, classification of the aborted checkpoint and restore after cancellation.
- S7 hidden-tag exclusion; repeated missing-ID ordinals beyond zero.
- Full nested-checkpoint identity/discovery for S10; core child resume and restore; wildcard and runtime override handling through core.
- A unique versions-seen difference classifier for after-breakpoints, including later supersteps and loops; after-gate topology as a separate core fixture.
- Chromium, reopened IndexedDB, Firefox/WebKit, LangGraph Python, real models, network providers and performance. Existing shipped Chromium tests remain regression evidence only.
- A durable static-reject marker; repeated reloads of a rejected static pause. The observed single-reload failure is sufficient to rule out static support.

## Implementation notes

The spike aliases core to `packages/core/src/index.ts` and imports the shipped requestInteraction helper without changing either. Its bounded static request has only node name and kind in props, a fixed component, and checkpoint/task-derived identity and revision. Native invalid node names fail before UI publication; no private graph value contributes to the synthesized request. The executor rejects ambiguous/failing snapshots and validates strict four-field requests. Continue follows the ordinary core action/schema/identity/inbox path and cannot satisfy the separate broker confirmation (CS11).

The missing-ID candidate uses `idless:<taskId>:<committedResumeCount>` and a bare `{ action, payload }` resume, never an ID map. The measured ordinal is zero. Committed resume writes pass through registerRestoredData before returning pending state; absence of that hook fails closed (CS12). A production implementation must reimplement this mapping, preserve registration and single-pause refusal, update prepare/runtime validation, and add new conformance cases with new goldens and Node/Chromium recovery evidence before claiming shipped support. Existing goldens, matrices, package source and other locks remain unchanged. No new core contract or ADR is proposed.
