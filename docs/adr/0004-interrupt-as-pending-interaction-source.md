# ADR-0004: Checkpoint interrupt is the source of truth for pending interactions

- **Status:** Proposed
- **Date:** 2026-10-28
- **Related:** brief §11.3, §12.1, §12.2; ADR-0001, ADR-0005, ADR-0009, ADR-0016
- **Revisions:**
  - 2026-10-28, with brief 0.3: Spike A's checks move to the M1 conformance suite (ADR-0016); Spike C runs before M2.
  - 2026-10-29: recorded Spike C browser evidence; status remains Proposed.

## Context

The v0.1 brief stored a pending interaction in two places: the LangGraph checkpoint and a host "UI projection" record. Because both could not be written in one transaction, it needed a reconciliation step. Two sources of truth for the same fact is how a reload ends up showing a different quiz.

LangGraph already persists pending interrupts in the checkpoint:

- `interrupt(value)` stores `value`.
- `graph.getState(config)` exposes pending interrupts (`tasks[].interrupts`).
- `graph.invoke(new Command({ resume }), config)` continues.
- On resume, the node that called `interrupt()` re-executes from its start. For an interrupt inside a subgraph, the parent node that called the subgraph also re-executes.

An external review pointed out a second crash window that the projection removal does not solve: between accepting a submission and the resumed checkpoint commit. If the receipt is saved after resuming, a crash can apply the answer twice. If it is saved before, a crash can leave an accepted answer that never advances.

## Decision

- The interrupt payload in the checkpoint is the single source of truth for what is pending.
- The node that waits for the user builds its display payload deterministically from committed state and passes it to `interrupt(payload)`.
- The host renders from `graph.getState(config)`, including after a reload. Any host-side projection is a cache that can be rebuilt.
- **Submission inbox.**
  - The host validates a user event against the interrupt payload: identity, `interactionId`, `viewRevision` and payload schema.
  - In one IndexedDB transaction that also checks the owner epoch, it writes the event to an inbox keyed by `interactionId`, with status `accepted`. A second event for the same `interactionId` is rejected there.
  - A single inbox processor calls `Command({ resume })`.
  - When the resumed checkpoint is durably committed, the entry becomes `consumed`.
- **Recovery** reconciles the inbox with the checkpoint:
  - `accepted` and the interrupt still pending → resume again with the stored payload;
  - `accepted` and the interrupt resolved → mark the entry `consumed`;
  - no entry → show the interrupt again.
- Effect IDs after resume are derived from `interactionId`, so a repeated resume reuses them through the effect journal.
- `interactionId` comes from the engine's interrupt ID, or from a deterministic host ID derived from the checkpoint. It never comes from the LLM, and it is never regenerated in the re-executed node.
- Code before `interrupt()` is deterministic and side-effect free. This applies to the interrupting node and to any parent node of an interrupting subgraph.
- MVP limit: one pending interrupt per run. Simultaneous interrupts get a typed `unsupported` error.

## Alternatives considered

- **Dual write with reconciliation (v0.1).** Rejected: two sources of truth for the UI.
- **Receipt after resume, no inbox.** Rejected: a crash can apply an answer twice.
- **Host record as the only source, with the graph polling it.** Rejected: fights the engine's own interrupt model.
- **Promise held in memory until submit.** Rejected: not durable.

## Consequences

- The host stores submissions in the inbox, not a second copy of the UI.
- Node authors must follow the "nothing before `interrupt()`" rule. The ESLint plugin and docs flag it where possible.
- Parallel interrupts need a later design: interrupt-ID routing and surface arbitration.

## Verification

- M1 conformance on LangGraph.js 1.5.1 passes on native Node, galaxie Node and Chromium:
  - pending interrupt IDs and request values are read from checkpoint `tasks[].interrupts`; sequence cases observe two distinct IDs;
  - the interrupted node re-executes, while preceding completed nodes do not (`prepare: 1`, `ask: 2`);
  - an interrupting subgraph re-executes the calling parent and its interrupted node, retaining completed child work (`callSub: 2`, `s1: 1`, `sask: 2`);
  - ID-map resumes deliver `{ action, payload }` to the node, including a `false` payload;
  - pause/final checkpoint history lengths are 3/5 for `async` and `sync`, and 1/2 for `exit` in the `prepare → ask → finish` case.
- M1 enforces one request per node: a second pause with the answered ID fails with `unsupported`, because calls in one node share an interrupt ID. Split sequential interactions across nodes. Parallel interrupts and static breakpoints remain unsupported. The subsequent single ID-less request implementation is recorded below.
- M1's inbox is in memory. Its entry becomes `consumed` on a resume segment's executor outcome; this does not establish durable checkpoint consumption or crash safety.
- M3 remains unverified: how resume values are persisted, whether repeating an accepted resume after a crash is safe, and the same conformance cases with the IndexedDB saver. The M1 transcripts observe values reaching the node, not the crash/recovery protocol.
- Spike C (2026-10-29, `spikes/c-ui-path/`): [recorded Chromium evidence](../../spikes/c-ui-path/README.md) rendered the typed Quiz from the committed interrupt and restored identical interaction identity and props from a deserialized session checkpoint. Generation stayed at 1; forged and old-identity events were stale, simultaneous submits were accepted/duplicate, and resumed grading succeeded. Core denied the URL variant on restore. The spike shim creates a new run by design; this does not verify the M3 durable inbox or crash protocol.
- AT-07, AT-08, AT-09, AT-15, AT-31, AT-35.
- Parallel/repeated-request spike (2026-11-10): the [Node evidence](../../spikes/parallel-interrupts/README.md) proves the top-level repeated-request design with ordinal IDs and restored-value registration through unmodified core; parallel interrupts remain refused because a completed no-write sibling cannot be classified. [Proposed ADR-0030](0030-several-engine-pauses-published-one-at-a-time.md) records the contract proposal; shipped behavior is unchanged.
- Static-breakpoint/ID-less-interrupt spike (2026-11-10): [Node observations and core proofs](../../spikes/static-breakpoints/README.md) record static breakpoints as **alternative** (explicit requestInteraction gate); synthesized reject leaves the checkpoint pending and inbox accepted. The spike proved a single top-level missing-ID interrupt reached through requestInteraction, using task-derived identity and a bare resume; the subsequent shipped implementation is recorded below. NodeInterrupt/raw GraphInterrupt remain refused because they throw again. The spike changed neither shipped behavior nor core; its broader breakpoint and ID-less shapes remain unverified. The shipped adapter now refuses compiled breakpoints at prepare; the separate [gate cases and refusal evidence](../../tests/conformance/README.md#static-breakpoint-refusal-and-gate-replacement) prove continue/reject parity and reload on Node and Chromium, including reopened Chromium IndexedDB, without changing core.

- 2026-11-11: [Single ID-less requests](../../packages/adapter-langgraph/README.md#id-less-interrupts) now use task-derived identity and bare resume, with native/Node/Chromium parity, all durability modes and Chromium IndexedDB recovery evidence. A body-invoked child without a checkpoint namespace completes after one answer; compiled child namespaces are refused. Exact valid NodeInterrupt/raw GraphInterrupt requests publish once and fail on the first answer; repeated child pauses and loop revisits remain unmeasured. Existing goldens, matrices and core are unchanged.

- 2026-11-11: The [NodeInterrupt pause-time discriminator spike](../../spikes/langgraph-nodeinterrupt-pause-time/README.md) records **alternative**: P7/P8 break strict parsing or stream parity, P9/P10 lose restore signals, and P12 verifies the complete-config `requestInteraction` replacement. No candidate reached the conditional core design proofs; shipped behavior is unchanged.
