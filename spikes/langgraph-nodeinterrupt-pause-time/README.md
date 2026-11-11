# LangGraph NodeInterrupt pause-time discriminator spike

This throwaway Node workspace measures whether a helper-raised ID-less request can
be distinguished from `NodeInterrupt(validRequest)` or a raw
`GraphInterrupt([{ value: validRequest }])` before publishing an unanswerable pause.
It uses scripted graphs, no model and no network calls. Shipped behavior is unchanged.

## Run

```sh
pnpm --dir spikes/langgraph-nodeinterrupt-pause-time install --frozen-lockfile --offline
pnpm --dir spikes/langgraph-nodeinterrupt-pause-time typecheck
pnpm --dir spikes/langgraph-nodeinterrupt-pause-time exec vitest run test/native.test.ts
pnpm --dir spikes/langgraph-nodeinterrupt-pause-time test
pnpm exec biome format --write spikes/langgraph-nodeinterrupt-pause-time/results
shasum -a 256 spikes/langgraph-nodeinterrupt-pause-time/results/*.json
```

Run the last three commands twice and compare hashes: formatted evidence must be
byte-identical. UUID/hash IDs become first-appearance labels per observation;
undefined fields are omitted as in the serialized native conformance transcripts.
The observer separately records own keys so an undefined `id` is not mistaken for
an absent key. The workspace and its byte-copied lock are isolated from root CI.

## Results

Recorded on 2026-11-11 with Node v24.15.0 and pnpm 11.21.0 on macOS. These are
deterministic functional observations, not performance measurements.

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
| Refuse exact-valid-request NodeInterrupt/raw GraphInterrupt at pause time | **alternative** | P7 breaks strict request parsing and stream parity; P8 changes the stream chunk; P9/P10 lose their signals on restore; P12 replacement passes in all modes. P14 also rules out refusing documented unmarked helper checkpoints. | None: replace the thrown interrupt with requestInteraction and complete node config. |

The outcome rule is **fixed before the final evidence run**: supported requires at
least one candidate passing all seven criteria below in `sync`, `async` and `exit`,
then passing core proofs K1–K5 in all three modes, including consistent refusal on
restore. Otherwise the outcome is alternative if P12 passes in all modes;
otherwise refused. An unmeasured critical probe counts as a failure. Supported
would mean design proven, with a separate implementation task, not shipped support.
Passing tests reproduce the evidence, including design failures recorded as
`pass: false`; they do not turn those failures into support.

## Native probes

Machine observations: [results/native.json](results/native.json). Baseline P1–P6
were run and inspected before candidate probes were written. P5 is reserved and
unused. Every listed row runs under all three durability modes.

| Probe | sync | async | exit | Observation |
| --- | --- | --- | --- | --- |
| P1 | pass | pass | pass | Shipped helper with stripped namespace: one root task, ID-less request, stream, callback, writes and reopened/reversed saver recorded. |
| P2 | pass | pass | pass | NodeInterrupt with the exact request has the same serialized stream and checkpoint surfaces as P1; callback name/keys differ. |
| P3 | pass | pass | pass | Raw GraphInterrupt has the same serialized surfaces as P1; callback own-id key differs. |
| P4 | pass | pass | pass | Bare stripped-namespace interrupt has identical surfaces to P1, including callback observations. |
| P6 | fail | fail | fail | No free persisted discriminator: P2/P3/P4 tasks, writes and reopened state equal P1 after serialization. |
| P7 | fail | fail | fail | D1 extra constant value field persists, but strict parseInteractionRequest rejects it and the stream differs. Native bare resume still applies once. |
| P8 | fail | fail | fail | D2 constant responseSchema becomes response_schema in stream, tasks and writes. A plain JSON Schema passes toJsonSchema unchanged and does not transform the answer, but breaks stream parity. |
| P9 | fail | fail | fail | D3 WeakSet marks are visible to callbacks and the streamed interrupt is the same object; the single root task is correlatable live. Serialized/reopened interrupts have no mark. |
| P10 | fail | fail | fail | D4 sees NodeInterrupt.name and the helper's own undefined id key live, but neither is a persisted helper-origin contract. |
| P11 | fail | fail | fail | Forged D2/D3 markers publish once, fail unsupported on the first answer, apply nothing and retain the accepted inbox. D1 fails strict parsing before publication. |
| P12 | pass | pass | pass | Complete-config requestInteraction replacement has an ID-bearing pause, publishes once, resumes by ID map and applies once, including a reopened-saver restore. |
| P13 | pass | pass | pass | D1/D2 markers survive both in-order and reversed-write reopened saver reads. |
| P14 | fail | fail | fail | All marker gates would refuse documented existing unmarked helper checkpoints; ID-bearing calls remain unchanged. Narrowed bare ID-less interrupt calls are listed below. |

## Candidate criteria

The `criteria` records in native.json give a boolean and deciding evidence for
every cell. These are native-stage verdicts; none qualifies for the conditional
parity executor. C3 for D4 is unmeasured and therefore fails.

| Criterion | D1 value marker | D2 responseSchema | D3 live mark | D4 error shape |
| --- | --- | --- | --- | --- |
| C1 live and reopened signal in all modes | pass | pass | fail | fail |
| C2 absent on unmarked thrown requests | pass | pass | pass | pass |
| C3 forgery keeps one publication, fixed failure, no application, accepted inbox | fail | pass | pass | unmeasured |
| C4 strict request, unchanged ID-bearing path and native stream parity | fail | fail | pass | pass |
| C5 constant marker and content-free refusal/observer | pass | pass | pass | pass |
| C6 public APIs within the locked peer range, no private-field heuristic | pass | pass | pass | fail |
| C7 no narrowing of a documented working shape | fail | fail | fail | fail |

D1–D3 use public `interrupt`, `responseSchema`, callback and GraphInterrupt APIs,
plus a native WeakSet; the measured versions are inside the adapter's peer ranges
`@langchain/langgraph ~1.5.1` and `@langchain/core ~1.2.20`. Other patch versions are
unmeasured. D4 depends on construction details, including an own undefined `id`
key that serialization removes. Markers are constant, content-free tripwires for
author mistakes, not authentication. The observer records only error names, keys,
booleans and reference comparisons; it never records error messages or stacks.
No span or log is added. Refusal reuses `toErrorInfo('unsupported')`.

Narrowing is explicit: D1/D2/D3 refuse unmarked bare `interrupt()` calls with a
missing namespace. That undocumented fallback would be an accepted trade-off.
D4 preserves that bare call live but refuses it on restore. Every candidate also
refuses the documented restoration of an existing unmarked helper checkpoint;
D3/D4 additionally lose the signal from a newly marked helper after reopen. No
grandfathering rule is proven: the old helper checkpoint is indistinguishable
from the thrown-request checkpoint. Complete-config ID-bearing calls bypass the
candidate helpers and remain unchanged (P14). Body-invoked child and sequential
candidate paths are not measured because no candidate survives.

## Core proofs

**No candidate reached core** for the conditional K1–K5 design proofs. The native
criteria already rule out every candidate, so K1 (early refusal), K2 (single
ID-less answer), K3 (two nodes), K4 (full native/galaxie transcript parity) and K5
(consistent refusal after restore) are skipped. There is no `results/core.json`
or candidate parity executor.

P11/P12 additionally use [test/protocol.ts](test/protocol.ts), a narrow spike-local
executor through unmodified core, to measure actual publication, dispatch, inbox
status and restore rather than infer them from native graph completion. It uses
the shipped pending reader behind the candidate gate; it is not the shipped
adapter and does not establish full transcript parity. P11 retains accepted
answers after failure and restore and applies no effect. D2 restores and retries
the same unsupported run; D1/D3 reject the restored pending read, which core maps
to the fixed `executor_error` (not `unsupported`). That is additional evidence
against a consistent restore refusal, not a core change. The replacement in P12
consumes its inbox once on both live and separately restored paths, reasserting
the earlier [CR2 result](../static-breakpoints/README.md#core-proofs).

## Author guidance

Replace `throw new NodeInterrupt(request)` and manually thrown GraphInterrupt
with `requestInteraction(request, config)`, passing the complete node config,
including after an await. Put one interaction in each node and side effects
after the interaction: LangGraph reruns the node prefix on resume. Do not strip
checkpoint namespaces. See the [adapter guidance](../../packages/adapter-langgraph/AGENTS.md#do)
and [ID-less limits](../../packages/adapter-langgraph/README.md#id-less-interrupts).

## Where native behavior cannot be matched

The serialized checkpoint contains no helper origin. A persistent marker changes
the stream the native goldens were recorded with; removing it before publication
would alter native streaming or stored request interpretation. A live mark
preserves that stream but cannot identify a checkpoint after reload. No candidate
satisfies both requirements without changing the measured contract.

Shipped behavior is unchanged: exact valid NodeInterrupt/raw GraphInterrupt
requests publish once and end `unsupported` on the first answer, retaining their
accepted inbox entries. String-valued NodeInterrupt remains refused before
publication. This spike changes no shipped source, core, existing test, golden,
compatibility matrix or existing lock. Only this workspace has a new lock.

## Not measured

- LangGraph Python; Chromium, IndexedDB, Firefox and WebKit for these candidates.
- Real models, network providers, performance and other peer patch versions.
- Loop revisits, repeated child pauses, second pauses in body-invoked children,
  parallel interrupts and static breakpoints.
- A cryptographic marker, author-written interrupt IDs, checkpoint migration or
  grandfathering, or full candidate native/galaxie transcript parity (K4).

The unchanged shipped conformance tests are regression evidence only; they do
not establish browser support for a candidate. No implementation follow-up is
drafted because the recorded outcome is alternative.
