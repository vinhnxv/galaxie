# ADR-0030: Several engine pauses published one at a time

- **Status:** Accepted (2026-11-14)
- **Date:** 2026-11-10
- **Related:** ADR-0004, ADR-0012, ADR-0017, ADR-0027

## Context

Core's `ExecutorAgent.pending()` returns one `PendingInteraction`. A dispatch resumes one interaction ID; the inbox and restore reconciliation compare accepted submissions with that committed pending ID. Publishing a list would change the public snapshot, executor contract, renderer and hosts.

LangGraph.js permits several tasks to interrupt in one superstep and several calls to `interrupt()` within one node. The shipped adapter refuses both shapes. The [Node spike](../../spikes/parallel-interrupts/README.md) observes LangGraph 1.5.1 with scripted values and tests a candidate mapping through unmodified core, under `sync`, `async` and `exit` durability.

The repeated calls share a raw interrupt ID. A task's committed resume-value list identifies which call is pending. Native resume maps must use the raw ID: a suffixed key delivers the wrapped object as the answer instead. Parallel state-writing branches can be serialized, but a completed no-state-write sibling retains a resume write and stale interrupt without a completion marker. The proposed done test cannot classify that case.

## Decision

Propose the following framework-neutral obligations for an executor that serializes engine pauses. This ADR changes no shipped contract or behavior; the maintainer reviews it before implementation.

1. **Publish one pause.** The executor exposes one committed pending interaction at a time through the existing `pending()` read and `interaction` event. The run snapshot is authoritative for what the host can answer. Native streams retain their engine payloads, including sibling pauses.
2. **Give each pause a stable identity.** Keep the first pause's existing interaction ID. Derive later IDs from committed engine state, never model content or a live counter. In the worked LangGraph mapping, ordinal zero keeps the bare raw ID; ordinal k uses `<raw>:<k>`, counting only that task's committed `__resume__` values. Before resume, route the answer to the selected pause's raw engine ID. Existing single-pause IDs and saved inbox entries therefore keep their meaning.
3. **Pick from the checkpoint alone.** Repeated reads and restore must select the same unanswered pause without remembering what was last published. The measured mapping orders by checkpoint task order, then raw ID, then ordinal. Task order remained stable across ten reads, a partial resume and a reopened saver returning pending writes in reverse order. If an engine cannot provide a stable pick, refuse that shape rather than let restore treat an accepted but hidden answer as resolved.
4. **Distinguish completed tasks from current pauses.** Ignore stale pause records only when committed engine evidence proves the task completed. LangGraph's non-special-write test handles state-writing siblings, but the no-state-write case failed. No broader parallel support follows from the successful state-writing cases.
5. **Keep materialized surfaces within the existing limit.** A surface record in a set of two or more pauses, or at a later ordinal, fails with the fixed `unsupported` error. Re-executed siblings can re-raise the same surface revision, and ADR-0027 retains one pending interaction per surface. Only strict four-field interaction requests qualify for the candidate multi-pause mapping.
6. **Register restored values before use.** Before returning pending state or replaying earlier answers into live code, pass every committed resume value to `registerRestoredData`. An executor needing that hook fails closed when it is absent. Core's URL/UI validation, private-value checks, submission validation, checkpoint-confirmed dispatch and single-use confirmations stay on their current paths.

These obligations do not weaken ADR-0012 or replace deterministic, side-effect-free node prefixes. Engines whose state cannot establish them remain refused. Runtime `pending()` and `run()` retain the fixed `unsupported` refusal: `prepare()` cannot inspect calls inside arbitrary node functions.

### Recorded outcomes

| Gap | Outcome | Evidence |
| --- | --- | --- |
| Parallel interrupts | **refused** | Native N5 fails in every durability mode. Successful N4, N6, N7, C6–C9, L3, L4, L6 and L7 do not resolve the missing completion evidence. |
| Several interaction requests in one node | **supported: design proven, implementation pending (ADR-0030 is Accepted)** | N1–N3, N8, C1–C5, C10, L1, L2, L5 and L8 pass for the measured top-level four-field requests. |

Repeated child-graph pauses remain refused: N9 did not establish deterministic discovery of the child namespace's resume values through the dynamically invoked child's parent state. The spike executor implements top-level fixtures only and declares `subgraphs: false`.

Until an implementation lands, authors split sequential requests into separate nodes. For parallel graphs, ask the questions before the fan-out, or chain interrupting branches so at most one task pauses per superstep, with one interaction request per node. The existing [interrupt-sequence conformance case](../../tests/conformance/cases/interrupt-sequence.ts) proves that single-pause path.

## Alternatives considered

- **Pending list in the snapshot and an additive executor read.** Makes several questions visible at once, but changes `RunSnapshot`, `ExecutorAgent`, renderer behavior and every host. The spike establishes no need for that UX change. Revisit if serial publication blocks a measured host workflow.
- **Batch answers in one resume.** Core's `RunCommand` identifies one interaction and `RecoveryStore.acceptSubmission` accepts one entry at a time. A crash between two accepts leaves a half-accepted batch. Batch answers need a separate atomic acceptance design.
- **Stamp the ordinal into the interrupt value.** Avoids reading the committed resume list, but depends on engine scratchpad internals and changes checkpointed request values. Keep the ordinal in executor identity mapping instead.
- **Optional `pendingIds()` for restore reconciliation.** An additive executor read could distinguish an accepted, still-unresolved sibling from the one currently published. The fake negative control demonstrates the risk: changing pick order consumes A without applying it, then core refuses A's later publication. Stable-order crash probes pass without this read, so it is not required by the measured happy paths. It would not itself fix the missing no-write completion evidence; any returned membership list would still need that evidence.
- **Filter sibling interrupts from native updates.** Breaks stream parity. Keep the streams and direct host submissions through the snapshot's one pending interaction.
- **Require recovery or forbid confirmed prefix writes as a new runtime rule.** No new rule is proposed. ADR-0012 already requires side effects after interrupts. Recovery with a stable effect scope replays a successful broker receipt, but does not authorize effects outside that broker or nondeterministic prefixes.

## Consequences

No core type change is needed for the measured top-level repeated-request design. A production adapter must reimplement the mapping and add conformance evidence; spike code stays throwaway. Browser/IndexedDB recovery is still required before that behavior ships.

The mapping differs from native interaction exposure: raw `updates` can show every sibling while the snapshot holds one; later interaction IDs contain an ordinal absent from the engine's raw ID; answers apply one by one. Cancelling mid-sequence can leave earlier answers applied. Hosts must use snapshot identity and core dispatch rather than infer answerable interactions from raw updates.

Partial resumes rerun unanswered prefixes. Two fake branches produced five total prefix executions, three during resumes; three fake and three LangGraph branches produced nine total, six during resumes. The N(N+1)/2 estimate matches resume-only work in these fixtures; initial execution adds N more. These are counts, not latency measurements.

In the confirmed prefix-write probe, three B-prefix executions caused three approvals and writes without recovery. With recovery and a stable scope, they caused one approval and write, followed by receipt replay. Old approvals remained stale across re-executions. Effects outside the broker can still repeat; keep them after interrupts or in a completed node.

Restore uses the same pick rule as publication. The negative control shows that unstable picks can lose an accepted answer even though inbox deduplication still works. Earlier committed answers also need explicit registration: the no-recovery L5 controls show that suppressing registration permits a private-value URL and a bounded outbound argument that core otherwise denies. No request-digest check is added here; deterministic question construction remains an author obligation.

## Decisions on the open questions (2026-11-14)

The maintainer delegated these decisions to the assistant, which recorded the recommended option for each. They are revisable only through a new ADR (see the ADR README rules).

- **Q1: accepted.** Serialized publication is the executor contract rule for engines that raise several pauses, with the first interaction ID preserved and later identities derived from committed engine state. Reason: it needs no core type change, the spike proved it for top-level repeated requests, and the alternatives change `RunSnapshot`, `ExecutorAgent` or `RunCommand` for every host. Acceptance covers the measured top-level repeated-request design only. Parallel interrupts stay **refused** while native probe N5 is unresolved, and repeated child-graph pauses stay refused (N9).
- **Q2: required, as follow-up design, not a blocker.** A request-digest check that binds a replayed answer to the question it answered is required before the design is described as hardened against nondeterministic prefixes. The shipped single-pause path has the same exposure today, so the implementation issue does not wait for it; it is tracked as its own spike.
- **Q3: yes, a separate ADR.** A surface record in a multi-pause set or at a later ordinal keeps failing with the fixed `unsupported` error until a separate ADR settles revision and region arbitration. This ADR grants no surface support.

Implementation is unblocked for the measured top-level repeated-request design, with the obligations and verification below. Nothing in this decision weakens ADR-0012.

## Verification

The [spike result](../../spikes/parallel-interrupts/README.md), [native observations](../../spikes/parallel-interrupts/results/native.json) and [core proofs](../../spikes/parallel-interrupts/results/core.json) record every probe, including failed design probes N5 and N9. Passing Vitest tests reproduce those failures; they do not claim those shapes work.

Native and integration probes cover all three durability modes. Core fake probes cover duplicate/stale dispatch, acceptance before commit, commit before publication, stable-order restore, the changed-order negative control, approval reuse, prefix counts and surface refusal. L5 isolates restored-value registration with and without the hook, without a recovery store or network access.

The implementation follow-up must add Node and Chromium conformance cases with new goldens, preserve existing goldens and unrelated matrices/locks, repeat critical crash/reload tests with a reopened IndexedDB saver, update runtime validation and the adapter's documented limits, and pass `pnpm check`. Parallel implementation is not proposed while N5 is unresolved. The maintainer decision on Q1–Q3 is recorded above.

### Shipped implementation evidence (2026-11-14)

The adapter now implements the measured top-level four-field repeated-request
mapping, without a core contract change. The earlier "implementation pending"
statements describe the state at acceptance; the Decision and Recorded outcomes
above retain that history. The [conformance evidence](../../tests/conformance/README.md#several-requests-in-one-node)
adds one native golden, zero-difference galaxie Node and Chromium comparisons,
recovery around both answers under `sync`, `async` and `exit`, and reopened
Chromium IndexedDB at ordinals zero and one. Existing goldens, the compatibility
matrix and other executors' locks are unchanged.

Real checkpoint-write interruption tests refuse stale completed-task pauses under
`sync` and `async`. Under `exit`, final task writes are not persisted before the
final checkpoint; the original second pause remains. None publishes a phantom
third interaction. Adapter tests also cover three requests, repeated reads, forged
IDs, missing registration hooks, registration before publication, abort identity,
invalid requests and the retained surface/parallel/child/ID-less refusals.
