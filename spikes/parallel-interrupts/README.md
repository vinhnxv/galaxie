# Parallel interrupts and repeated interaction requests

Throwaway spike (brief §16.2) for LangGraph.js 1.5.1. Scripted graphs, a fake executor and a spike-local executor exercise the unmodified core source on Node. No model or network service is called. Nothing here becomes package code.

## Run it

From the repository root, with Node.js 24 and pnpm 11:

```sh
pnpm install
pnpm --dir spikes/parallel-interrupts install --frozen-lockfile
pnpm --dir spikes/parallel-interrupts typecheck
pnpm --dir spikes/parallel-interrupts test
pnpm exec biome format --write spikes/parallel-interrupts/results
```

For the native observations alone:

```sh
pnpm --dir spikes/parallel-interrupts exec vitest run test/native.test.ts
```

The tests regenerate [native evidence](results/native.json) and the C/L sections of [core evidence](results/core.json). Test files run serially so those sections cannot overwrite each other. Run the full test and result-format commands twice; the second run must leave both evidence files byte-identical. With pnpm 11 and Vitest 5, `test -- test/native.test.ts` also selects sibling tests; the `exec` form above isolates the file.

## What the spike does

- Native graphs pause twice in one node, fan out through edges or `Send`, finish a sibling without a state write, and invoke an interrupting child from a parent node.
- The checkpoint reader derives ordinal interaction IDs from the pending task's own committed `__resume__` values. The first pause keeps the raw ID; later pauses use `<raw>:<ordinal>`. Interrupt-keyed resume-map writes do not increase the task ordinal.
- A fake executor tests core dispatch, durable acceptance/consumption, crash windows, confirmations and surface refusals independently of LangGraph.
- The spike-local LangGraph executor publishes one checkpoint-derived pause at a time and resumes its bare raw ID. It registers earlier committed answers before pending validation and replay. Reopened savers deep-copy serialized storage and writes into a new `MemorySaver`.
- Native `values` and `updates` events remain intact. The snapshot identifies the one answerable interaction; raw sibling interrupt updates do not authorize another submission.

## Results

Recorded on 2026-11-10, Node.js 24.15.0 and pnpm 11.21.0. Native and LangGraph/core probes run under all three durability modes: `sync`, `async`, `exit`. Fake-engine probes use explicit committed-state boundaries rather than durability modes. Formatted evidence was reproduced on consecutive runs.

| Package | Exact version |
| --- | --- |
| `@langchain/core` | 1.2.20 |
| `@langchain/langgraph` | 1.5.1 |
| `@langchain/langgraph-checkpoint` | 1.2.0 |
| `zod` | 4.6.7 |
| `@opentelemetry/api` | 1.10.0 |
| `vitest` | 5.0.5 |
| `typescript` | 7.0.2 |
| `@types/node` | 24.19.2 |

### Outcomes

| Gap | Outcome | Deciding evidence | Follow-up |
| --- | --- | --- | --- |
| G1: parallel interrupts | **refused** | N5 fails in every mode: a finished no-state-write sibling retains a resume write and stale interrupt without `NO_WRITES`, so the proposed done test cannot classify it. N4, N6, N7, C6–C9, L3, L4, L6 and L7 pass but cannot override that failure. | ADR-0030 is Accepted for the repeated-request design; no parallel implementation issue. |
| G2: several interaction requests in one node | **supported** | N1–N3, N8, C1–C5, C10, L1, L2, L5 and L8 all pass. Ordinal IDs, raw-ID resumes, recovery and restored-value registration work for the measured top-level nodes. | `Support several interaction requests in one LangGraph node with ordinal interaction IDs`, after ADR review. |

**Supported means design proven, implementation pending (ADR-0030 is Accepted).** Both shapes remain unsupported in the shipped adapter. This spike adds no conformance case, golden or compatibility-matrix entry. [ADR-0030 (Accepted)](../../docs/adr/0030-several-engine-pauses-published-one-at-a-time.md) records the executor obligations and alternatives.

For parallel graphs, ask the questions before the fan-out, or chain the interrupting branches so at most one task pauses per superstep, with one interaction request per node. For repeated requests in shipped code, split the requests into separate nodes. The existing [interrupt-sequence case](../../tests/conformance/cases/interrupt-sequence.ts) proves that path.

Repeated child-graph pauses remain refused. N9 did not locate a child snapshot/config through the dynamically invoked child's parent `getState(config, { subgraphs: true })`; deterministic child resume-value discovery was not proven. This is a limit of the measured path, not a claim that every child-graph registration behaves that way. The spike executor declares `subgraphs: false`.

### Native probes

All entries link to [native.json](results/native.json); generated IDs are normalized to first-appearance labels.

| ID | Observation | Design result |
| --- | --- | --- |
| N1 | Both requests in one node use the same raw ID. | pass, all modes |
| N2 | The task's committed resume list contains one answer at the second pause; ordinal is 1. | pass, all modes |
| N3 | A second bare-ID resume reaches the second request; node body executes three times. | pass, all modes |
| N4 | Edge and `Send` fan-outs expose two tasks with distinct raw IDs. | pass, all modes |
| N5 | A state-writing sibling is recognized as done; an answered sibling returning `{}` is not. | **fail**, all modes |
| N6 | Pick order is stable across ten reads, partial resume and reversed returned pending writes after saver reopen. Task order remains stable; no raw-ID fallback is needed. | pass, all modes |
| N7 | Answering A reruns B's prefix; A executes twice, B three times, join once. | pass, all modes |
| N8 | A suffixed resume-map key delivers the wrapped map instead of the intended answer. | pass, all modes |
| N9 | The dynamic child's checkpoint snapshot was not located through the parent. | **fail**, all modes; child shape refused |

N5 deliberately answers the no-write sibling while another task remains paused. Replaying its interrupt already emits a `__resume__` write. LangGraph's runner adds `NO_WRITES` only when the task has no writes at all, so no completion marker is persisted for this case. The checkpoint reader consequently retains the old interrupt. The passing test harness asserts this observed failure and records `pass: false`.

### Core proofs

See the C section of [core.json](results/core.json).

| ID | Observation | Result |
| --- | --- | --- |
| C1 | `r` then `r:1` publish and receive their answers once. | pass |
| C2 | An earlier answer is `duplicate` during resume and while the next request waits. | pass |
| C3 | A premature or checkpoint-mismatched `r:1` answer is `stale` and starts no segment. | pass |
| C4 | Accepted second answer before commit is applied once after restore. | pass |
| C5 | Committed second answer is consumed on restore without another application. | pass |
| C6 | Parallel fake pauses publish and apply A then B. | pass |
| C7 | All three stable-order crash windows preserve each accepted answer once. | pass |
| C8 | Prefix writes get fresh single-use approvals without recovery; stable-scope recovery replays the receipt. | pass |
| C9 | Prefix counts recorded for two and three branches. | pass, measurement |
| C10 | A surface in a multi-pause set or at ordinal 1 fails `unsupported`, without publishing that surface. | pass |
| pick-order-negative-control | Changing the pick at restore consumes A without applying it; later publication of A fails `unsupported`. | expected failure reproduced; outside C7's design result |

C8 measured three B-prefix executions: three approvals/writes without recovery, one approval/write with recovery. Reusing an approval immediately or during a later execution returns `stale`. This does not permit prefix side effects: ADR-0012's author obligation still applies.

### LangGraph through core

See the L section of [core.json](results/core.json).

| ID | Observation | Result |
| --- | --- | --- |
| L1 | Two top-level requests publish bare/ordinal IDs, accept two answers and produce both values. | pass, all modes |
| L2 | Reload preserves the second request; the old run ID is `stale`, the earlier answer on the restored run is `duplicate`. | pass, all modes |
| L3 | Parallel state-writing branches publish one at a time and join once. | pass, all modes |
| L4 | All three crash windows reopen the saver and preserve each accepted answer once. | pass, all modes |
| L5 | Earlier answers register before URL validation and outbound replay; no-recovery controls isolate that registration. | pass, all modes |
| L6 | With askA answered first and no-write noteB last, noteB publishes once and the graph completes. This does not cover N5's earlier no-write completion. | pass, all modes |
| L7 | Three-branch prefix counts recorded. | pass, all modes; measurement |
| L8 | An unstripped suffix produces the wrong native answer; the executor's stripped resume reaches the correct request. | pass, all modes |

L5 uses fixed private canaries, an allowed-origin URL and a scripted outbound capability. With registration, core denies publication of the URL carrying the earlier answer and denies the outbound argument before the host callback. Suppressing registration in a test-only wrapper allows both controls, proving the denial is not just a consequence of restored inbox labels. The outbound half omits the recovery store so inbox registration cannot supply the missing protection. No network request occurs.

### Re-execution counts

| Engine/fixture | Branches | Prefix executions including initial run | Resume-only executions | N(N+1)/2 estimate for resumes |
| --- | --- | --- | --- | --- |
| Fake | 2 | 5 | 3 | 3 |
| Fake | 3 | 9 | 6 | 6 |
| LangGraph | 3 | 9 | 6 | 6 |

Completed state-writing siblings do not rerun. Unanswered siblings rerun their prefixes on partial resumes. The estimate describes resume work only; including the initial N prefixes gives N + N(N+1)/2 in these fixtures. Counts are observations, not performance gates.

## Not measured

- Chromium and reopened IndexedDB; the implementation follow-up must repeat critical cases there.
- Real models, downloads, latency, memory and host UI behavior.
- LangGraph Python or any other executor.
- Arbitrary mid-write storage faults, cross-tab ownership races or nondeterministic node prefixes. Crash gates here surround engine resume/settlement; existing core tests retain their own coverage.
- Deterministic repeated-child ordinal discovery and materialized surfaces in multi-pause sets or at later ordinals.

## Implementation notes

The only harness changes beyond the scaffold are serial test-file execution for shared evidence and the truly focused Vitest invocation above. Native task order was stable, so the planned fallback order was not needed. The no-write sibling hypothesis failed; the documented refusal follows the predefined outcome rule rather than changing package source or test expectations to claim support.
