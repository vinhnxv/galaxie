# @galaxie-ai/adapter-pyodide

> This package is experimental and is not published to a package registry. Its API can change in any commit without notice.

An experimental executor adapter for trusted LangGraph Python graphs, pydantic-ai
agents and DSPy programs running in a dedicated Pyodide 314.0.7 module Worker. Agents use the Python `galaxie` proxies;
the existing JavaScript router and broker own routing, consent, labels, budgets,
credentials, output checks and capability authorization.

The host supplies `createPyodideAdapter({ createWorker, runtimeUrl, wheelsUrl,
localWheels, onBoot?, framework? })`. The default framework is `langgraph`;
`framework: 'pydantic-ai'` or `framework: 'dspy'` selects its separate executor. `createWorker` returns a port with `postMessage(string)`,
message and error listeners, and `terminate()`. A browser `Worker` satisfies that
shape. Node hosts wrap `worker_threads.Worker`. Constructing the adapter fetches
nothing and starts no Worker; `prepare` loads the source files and boots the interpreter.
All source downloads, including their response bodies, share a 30-second deadline.
Expiry rejects preparation with the fixed `timeout` error; explicit cancellation
keeps the `cancelled` outcome. The download timer is cleared before Worker boot.

The native reference environment and the Worker pin cryptography 50.0.2.
The Worker uses a [vendored WASM wheel](../../python/wheels/README.md) linked to
OpenSSL 4.0.3 because Pyodide 314.0.7 supplies only 47.0.0. Framework versions
and the msgpack 1.2.4 pin stay aligned across both environments; the lock test
requires every shared distribution to have one version (ADR-0022).

The agent descriptor is `{ baseUrl, files, module, entry }`. Source paths are relative
Python or JSON files, the module is a dotted Python import name, and the entry is a
zero-argument function returning a LangGraph graph, or an `Agent`/`Executor` for
the pydantic-ai framework, or a `dspy.Module`/`galaxie.dspy.Executor` for DSPy. Sources and wheels are same-origin in
the browser and fetched with credentials omitted. On Node, the runtime directory may
be local because native ESM cannot import an HTTP module; agent files and wheels may
still be served from loopback. The host serves runtime assets together and supplies
the two locally built wheel records, including their byte sizes and SHA-256 hashes.

Services are `{ chatModels, checkpoints? }`; `chatModels` is keyed by provider ID. Each entry is a LangChain
`BaseChatModel`, or a function receiving `{ credential }` and returning a model when
the provider descriptor requires per-call credentials. Implementations are checked
against core's preparation requirements. Credentials remain in JavaScript.

Every provider invoke and stream receives the lease's `maxTokens` output limit,
including tool-bound and schema calls. The closed Python bridge has no caller
token-limit option. Supported providers retain any lower constructor limit;
Built-in AI has no output-token limit and ignores the value. Actual usage may
still differ from the reservation. Coverage uses mocks and injected provider
fakes only; no real provider limit behavior is measured. See
[provider limits](../models/README.md#output-token-limits).

`galaxie.bridge/v2` accepts JSON strings up to 1,048,576 UTF-8 bytes. It carries boot,
run, pending, checkpoint, model, capability, abort and result operations. Both directions validate the
closed envelopes and payloads without code generation. Model replies reach Python
only after output checks; usage settles the router lease, and failures charge its
reservation. Capability calls preserve the full executor task namespace as the
broker's effect scope. Errors carry fixed codes and messages, never exception text.
Version 1, unknown operations and unexpected notifications are rejected. Worker
`stream` notifications carry graph chunks; host `model-chunk` notifications carry
checked text deltas for an open streamed model call.
Oversized messages fail with the fixed `unsupported` error.

Cancellation asks the Worker to abort. If no acknowledgment arrives within 500 ms,
the adapter terminates it; the next run boots a fresh Worker. This is a Worker
liveness bound, and core still owns run settlement. Late service replies cannot be
sent to a cancelled Worker or a later run. Disposal terminates the interpreter.

Interrupts and resume are enabled. Compile graphs with the Worker-owned saver:

```python
from galaxie.langgraph import checkpointer, request_interaction

# Inside the zero-argument graph factory:
graph = builder.compile(checkpointer=checkpointer())

# Inside a node, including after an await:
answer = request_interaction({
    "surfaceId": "main", "viewRevision": "r1", "component": "example.Question/v1",
    "props": {"question": "Continue?"},
}, config)
```

`checkpointer()` fails `unavailable` outside a configured Worker. The Worker rejects
a graph compiled with another saver, including no saver. Python checks request shape;
JavaScript applies core's interaction parser and UI/URL policy. `pending(sessionId)`
reads committed state, and resume sends `{action, payload}` by interrupt ID. Completed
nodes do not re-run; the interrupted node does. Parallel or ID-less interrupts,
static breakpoints and reusing an answered interaction fail `unsupported`.

For LangGraph Python, `interrupts`, `resume`, `checkpoints`, `streaming` and
`subgraphs` are true. For durable sessions, supply
`services: { chatModels, checkpoints: saver.byteRecords }` and
`recovery: saver.recovery` from the same app/principal-scoped
[`IndexedDBSaver`](../storage-indexeddb/README.md#python-byte-checkpoints). The Worker
injects `GalaxieCheckpointer`; Python serializes state and writes, and JavaScript
owns storage, fencing and recovery. A fresh runtime can restore the same pending
interaction after IndexedDB reopen; completed nodes do not re-run. Accepted answers
reconcile and successful broker writes replay under their full task namespace.
Keep capability call order deterministic within each task and pass its explicit config.

Without `checkpoints`, the injected saver remains in memory: cancellation or Worker
loss discards those sessions and pending/resume fails `unavailable`. With durable
storage, pending can boot a fresh Worker and read the saved session. Pending bridge
contexts allow only same-session checkpoint reads; a cancelled run permits checkpoint
writes until settlement or the existing 500 ms Worker bound. The complete tuple,
including writes and parent writes, must fit one 1 MiB bridge message after base64.
The async Python saver requires a thread-scoped config for listing; synchronous
saver methods and listing every session from Python are unsupported.

Nested graphs preserve stream paths, child interrupts and resume. Durable restore
uses the same scoped byte-record port, including child checkpoint namespaces.
The `astream` loop emits live `values`, `updates`,
`messages` and `custom` events with `executor: 'langgraph-python'` and path arrays,
while preserving the graph's final output schema. Streams are not retained in the
replayable event journal; subscribe before the chunks you need. Lifecycle events
keep their original identities and sequence numbers on replay, with gaps for streams.
Interrupts project to `{id, value}`, tuples to arrays, and messages to
`{type, content, id}`. Message metadata includes only `langgraph_node` and
`langgraph_checkpoint_ns`. Other values must be JSON; non-JSON or oversized chunks
fail `unsupported` without their content.

`GalaxieChatModel` supports asynchronous text generation and streaming, with optional
stop strings. Streamed calls require a provider declaring `streaming`; graph message
streaming can select this path even for Python `ainvoke`. JavaScript checks each
growing reply before sending its delta to Python, then checks the complete text and
settles usage before the terminal response. A block fails `denied` and stops later
deltas; previously allowed text cannot be retracted. The final Python chunk carries
usage without repeating text. Tool calls and multimodal messages remain unsupported.
Raw graph streams can contain working state and bypass routed-model output checks;
hosts must select the checked message projection before rendering text. The RAG
application renders checked answer-node messages and its final result as React
text. Default sessions remain in memory; opt-in passage review uses a registered
interaction and scoped durable checkpoints on either LangGraph executor. The
pydantic-ai example uses the separate approval flow described below.

Python code is trusted under [ADR-0018](../../docs/adr/0018-python-agents-through-pyodide.md).
It can import `js` and use the Worker's APIs. A dedicated Worker does not isolate
untrusted agents; the host's CSP and advisory Python lint aid have documented limits.
The entry disables classic `importScripts` before loading Pyodide because its
module-worker feature probe otherwise reaches a Trusted Types sink. This preserves
the strict CSP and does not create a script policy.

The third-party wheel inventory is compiled into the Worker and every byte count
and SHA-256 is checked before installation. Local wheels and agent sources share
the page's build trust. Pyodide itself loads its loader, WASM glue, WASM and standard
library assets; this adapter does not bind those runtime bytes. The example serves
them same-origin. A host serving them from a CDN needs SRI or pinned hashes; this
package does not implement that deployment path. Replacing the page and its trusted
build metadata defeats these artifact checks.

See [coding guidance](AGENTS.md) and the [rag-browser example](../../examples/rag-browser/README.md)
for setup and the measured verification limits. Tests use synthetic fixtures and
mock models, with no real model or corpus download.

For trusted pydantic-ai agents, select `framework: 'pydantic-ai'` and executor
`pydantic-ai-python`. The entry returns an `Agent` or `galaxie.pydantic_ai.Executor`.
The pinned runtime uses `pydantic-ai-slim==2.60.0` and `pydantic-graph==2.60.0`,
without provider SDKs. Use `GalaxieModel(role)` for routed model calls and
`capability_tool(...)` for broker-bound tools. JavaScript checks reply text,
tool-call arguments, IDs and names on every growing chunk and at completion.
Only checked reply text reaches `messages`; tool arguments and results do not.

Tool-less agents can use `output_type=NativeOutput(Model)` to send the output
schema through the routed provider's `jsonSchema` constraint, without putting it
in a prompt. The host must declare `structured-output` for the provider; streaming
also requires `streaming`. Python validates the checked reply. Native validation
retries carry a one-based `repairAttempt` through the bridge and consume the
route's `ModelRoute.repairAttempts` (default `0`) and the shared run repair budget
(default `2`); the host must enable repairs as well as the agent's output retries.
Tool-output and `PromptedOutput` retries remain ordinary model calls. Native output
with function tools, non-empty or unknown toolsets, deferred requests or a string
schema template fails `unsupported` at prepare. Agent-level callable settings and
every setting except `stop_sequences` are also refused at prepare; model- or
capability-contributed settings and later tools are refused before the bridge.
Use host provider configuration for sampling and `ModelRoute.maxTokens` for output
limits. The [spike record](../../docs/adr/0018-python-agents-through-pyodide.md#pydantic-ai-nativeoutput-and-model-settings-spike-2026-11)
lists provider constraints and the mock-only evidence, including OpenAI strict
schema requirements. Native retry feedback includes pydantic validation detail
sent only to the routed model; repair accounting is cooperative with trusted Python.

**Builtin and native tools.** pydantic-ai 2.60.0 native tools (formerly builtin tools) remain refused: `advisor`, `code_execution`, `file_search`, `image_generation`, `mcp_server`, `memory`, `tool_search`, `web_fetch`, `web_search` and `x_search`. Static native capabilities and callable native factories fail fixed `unsupported` at prepare, even a factory that would return `None`; the auto-injected optional `tool_search` is permitted, while deferred loading fails at the first request. Required `tool_search` conflicts with that automatic declaration upstream; adding it after agent construction is refused at prepare. Overrides and direct native requests fail `unsupported` before any model, capability or interaction bridge request. Native history parts fail `unsupported`, malformed native replies and bridge shapes fail `invalid`, and array provider content fails `unsupported` at the adapter before Python delivery. For retrieval jobs, use `capability_tool(name, capability, schema)` or `WebSearch(native=False, local=<capability_tool>)`: grants, labels, budgets, host confirmations for writes and positional effect scopes apply through the broker. The scripted ordinary/local search transcripts match but need two model requests, so the fixed one-request outcome rule records refusal rather than an alternative. Code execution, image generation, memory and advisor tools have no replacement here. Local network fallbacks are unmeasured; a host-registered provider that executes tools internally and returns only text takes on those controls outside what the adapter can observe. See the [mock-only evidence and limits](../../tests/conformance/README.md#pydantic-ai-native-tool-refusal-probes).

This executor declares `streaming`, `interrupts`, `resume` and `checkpoints` true.
Supply `services.checkpoints: saver.byteRecords` and `recovery: saver.recovery`
from the same scoped `IndexedDBSaver` to restore after reload. Without the recovery
store, core cannot compare session identity, so opening a session that another
executor created starts a new conversation beside its rows instead of failing.
Snapshots are bound to their session. Each pause and
completion stores a pinned `ConversationTypeAdapter` snapshot containing message
history, usage, conversation identity and deferred requests. Pending interactions
retain their IDs after a fresh Worker and reopened IndexedDB. Accepted answers
reconcile through recovery, and succeeded write receipts replay without invoking
the binding again. An unreadable snapshot fails `unrecoverable`; another executor's
session is refused before checkpoint reads. Exports copy each byte row's executor
tag and omit personal content unless explicitly requested.

Without the byte-record port, pending conversations live in Worker memory only;
cancellation or Worker loss discards them, and subsequent pending/resume fails
`unavailable`. Snapshots cover pause and completion boundaries, not arbitrary
mid-run replay. Write deduplication requires recovery and deterministic call order;
a replay with changed arguments fails `unrecoverable`. Keep the existing app/principal
scope, logout fencing and ownership composition. `subgraphs` stays false: the
[delegation probes](../../tests/conformance/README.md#pydantic-ai-agent-delegation-probes)
observe checked child deltas without host child events or paths. Plain delegation
has a measured alternative: forward usage and derive a stable, distinct child
conversation ID, with stable delegate tool-call IDs across parent model replay.
Regenerated delegate IDs change the child scope and can repeat a write; this
variant is unmeasured. A fresh child ID repeats a write after reload, and simply
reusing the parent's ID collides with its effect positions. Explicitly hoisting child
approval state into the parent's metadata completes and restores in the measured
pattern, using an author resume callback that preserves child state. These are
probe-local patterns; an executor-owned helper, hoist API and public-only nested
model/capability guard remain follow-up work. No nested-run refusal ships yet.
Prefer flattening gated tools into one agent's capability-backed tools. Sequential
native-output delegates share repair accounting; outer snapshot validation does
not validate author-owned child metadata. Browser delegation, real providers and
general nested checkpoint semantics remain unmeasured.

Include `DeferredToolRequests` in the agent's output types to pause on
`requires_approval`, `ApprovalRequired` or `CallDeferred`. Wrap the agent in `Executor(agent,
interaction=..., resume=...)`. The author's synchronous `interaction(requests)`
returns one `{ surfaceId, viewRevision, component, props }` request for all deferred
calls in that response. Invalid requests fail with fixed `unsupported` errors.
JavaScript still applies UI bindings, URL policy and accepted/consumed submission
handling. Deferred arguments in display props must be checked text:
use `call.args_as_json_str()` as text, never parse it into display directives or HTML.

`pending(sessionId)` returns that interaction, and resume must name its interaction
ID. Each pause gets an ID derived from the session's conversation identity and pause
ordinal. Wrong or answered IDs fail `stale` without executing tools. Model tool-call
IDs remain unique within retained conversation history; fresh starts in the same
session may reuse them while receiving distinct interaction IDs and effect scopes.

Without an author `resume`, the only accepted actions are exact `approve` and
`deny`, with payload `{ "toolCallIds": ["every-pending-approval-id"] }`. The list
must cover all approvals exactly once, with no external deferred calls. Approval
executes the tools; denial supplies native denial results to the model. Unknown
actions or incomplete payloads fail `invalid` without running a tool. For mixed
decisions or external results, synchronous `resume(requests, action, payload)` must
return `DeferredToolResults` covering every approval and external call exactly;
the Python `Executor` rejects missing, extra or invalid results before execution. The
author owns payload interpretation; the host binds its actions and payload schemas.
Tool-call IDs must be unique across the history retained through an approve/resume
chain, so a model that repeats an ID such as `call_0` within one chain fails
`invalid`; a fresh start may reuse it.

The [pydantic-ai matrix](../../tests/conformance/compatibility-matrix-pydantic-ai.json)
records the native CPython, Node Pyodide and real headless Chromium cases. For
scripted prompted-output retries whose `RetryPromptPart` has no tool name, create
`MockChatModel(script, { sequence: 'assistant-turns' })`. That opt-in mode chooses
the last scripted human prompt and advances from assistant turns in retained history,
including after a fresh model is constructed; default tool-call sequencing stays unchanged.

The maintained LangGraph RAG transcript matches across native CPython 3.14, Pyodide on Node
and Chromium, and the JavaScript graph on Node and Chromium. A separate Chromium
boot test installs the locked wheel set and imports LangGraph under the unchanged
strict page and Worker CSP, with zero policy violations. Node and browser bridge
tests exercise real Python with JavaScript model/broker controls; model inference
and retrieval replies are synthetic. The [local observations](../../examples/rag-browser/README.md#local-python-observations)
record response-body bytes and fresh-Worker startup boundaries, separately from
unmeasured GitHub CI and reference-device runs.

All twelve [Python reference cases](../../tests/conformance/cases-python/) pass on
native CPython, Node Pyodide and real headless Chromium: linear, branching,
subgraph, model-without-config, model-failure, capability, interrupt-resume,
interrupt-sequence, interrupt-subgraph, both interrupt durability modes and step-limit.
The eight non-Stage-A cases compare stream projections, mode order, paths and
terminal output or fixed errors; the four original interrupt cases compare pending
IDs/values and final state/counters. Model and capability probes use the JavaScript
router and broker. The [Python comparison matrix](../../tests/conformance/compatibility-matrix-python.json)
records generated message IDs and fixed error mappings; full checkpoint histories
are not compared on Pyodide lanes.

Four reload cases match native reconstruction after fresh Worker/runtime creation
on Node and page navigation with IndexedDB reopen in Chromium. `interrupt-subgraph`
restores the same pending interaction and finishes with `{ callSub: 1, s1: 0, sask: 1 }`.
The three original reload cases also reconcile accepted answers. A separate
parent-write probe proves one host write across two parent executions, including
reopened storage. A nested probe proves distinct effect IDs for two parent calls
and a child call, with the full three-part task namespace and stable receipt replay.
Node also checks checkpoint writes during cancellation settlement. Native serializer
tests cover all twelve cases, RAG and effect fixtures; exceptions decode as `repr`
strings and tuples as msgpack arrays, with strict equality otherwise.
No real model or device measurements were added.

The RAG example offers all four executors in its built mock mode. The two
LangGraph agents retain their shared review transcript and retrieval-subgraph paths.
The pydantic-ai agent uses a capability-backed `search_docs` tool, then optionally
raises `ApprovalRequired` from `review_passages` with trusted retrieved passages in
persisted metadata. Its registered interaction exposes IDs/titles only; the author
validates kept IDs before approval, and citations come from trusted tool history.
The final cited answer is text output so checked deltas can stream.

Bounded Chromium page tests cover lazy selection, retrieval/citations, selected
wheel-set byte totals, review reload through reopened IndexedDB, resume, Start over
deletion, executor switching and an injected-passage output block. Review instances
use scoped byte records, the saver's recovery store and fenced Web Lock ownership.
The pydantic-ai choice requires an answer-role provider declaring `tool-calling`;
the bundled WebLLM and Built-in AI descriptors lack it, so only mock mode currently
offers that choice. See the [mock command and review steps](../../examples/rag-browser/README.md#passage-review-with-mock-models).
A mock-only hands-on Chrome check of pydantic-ai in the RAG example (2026-10-31) covered review, reload restore, resume and Start over. A mock-only hands-on Chrome check of DSPy (2026-10-31) covered a cited answer, review with two kept passages, reload restore of the executor and pending review, resume and Start over. Real models remain unmeasured.

## DSPy programs

Select `framework: 'dspy'` and executor `dspy-python`, pinned to DSPy 3.4.1.
The entry returns an async `dspy.Module` or `galaxie.dspy.Executor(module,
input=..., output=..., adapter=..., stream_fields=...)`. By default, JSON input
is passed as keyword arguments to `module.acall`, and prediction fields become
JSON output. Bind predictors to `GalaxieLM(role)` and call capabilities through
`galaxie.capabilities.call` or `galaxie.dspy.capability_tool`. The custom-engine
LM uses the existing bridge v2 text/tool-call fields; JavaScript checks raw text
and arguments before ChatAdapter, JSONAdapter or ReAct parses them.

`streaming`, `interrupts`, `resume` and `checkpoints` are true; `subgraphs` is
false. Nested modules have no checkpoint namespaces, interrupt propagation or
nested stream paths: a pause unwinds the whole program. Sync entry points,
`dspy.Parallel`, threaded `Evaluate`,
optimizers, multimodal inputs, embeddings, service retrievers and provider-string
LMs are unsupported. Offline-optimized JSON state has the scripted evidence and
limits [below](#offline-optimized-program-state).
JSONAdapter works without streaming; provider `response_format`/native schema
output is unsupported. The default ChatAdapter disables JSON fallback, since a
fallback would change the replay call sequence. Parse failures end the run.

An `Executor` with `stream_fields` always streams in the Worker, even if the host
does not subscribe; its provider must declare `streaming`. Each declared field
must identify exactly one predictor output annotated as plain `str`. Only checked
text for those fields reaches `messages` as `{ field, text }`; markers, reasoning
outside declared fields and tool data are omitted. Content-free `updates` mark
each model call (`{ kind: 'model', index }`), tool call, pause and replay. Reset
displayed answer text at each new model marker. Streaming ReActV2 requires
`next_thought` annotated as `str`; its default annotation does not qualify. A
field header indented on its line is not streamed, though final output still
uses ChatAdapter's parsed value. JSONAdapter streaming fails `unsupported`:
its `jiter` parser is absent from the Worker set.

`request_interaction(request)` pauses from module or tool code. Resume reruns the
program against a journal of completed model calls, capability results and
interaction answers. It requires deterministic author code apart from those
calls, including stable inputs and call order. Matching entries replay silently
without routed calls or budget charges; divergence fails `unrecoverable` before
later live calls. Use the same scoped byte-record port and recovery store as
above for fresh-Worker restore, accepted-answer reconciliation and write-receipt
replay. Without them, state is Worker-local. Journals must fit the 1 MiB bridge
limit, including base64 envelopes, before a pause can publish. Completion stores
a compact counter marker without input or journal. Work after the last committed
pause can run again after Worker loss; broker writes need recovery and stable
call positions. Other effects have no replay guarantee. Wrong executor, DSPy
version, journal format or session identity is refused.

Core's framework-neutral `registerRestoredData` callback on `RunRequest` and
`ExecutorAgent.pending` re-registers restored JSON strings as private. The DSPy
adapter passes stored input and journal results before restored interaction URL
validation or any live outbound call; hosts constructing those contracts directly
must supply the hook when restoring such data or restore fails closed. Core
contains no framework-specific restore logic. This does not retrofit other
executors' stored histories.

DSPy ReAct turns ordinary exceptions from author tool code into observations
containing a five-frame traceback, including file paths and source lines. The
next routed model call carries that observation. Keep sensitive details out of
author exceptions. Galaxie failures retain their fixed codes and end the run
before another model call; they never travel as traceback observations. Disk and
memory caches, history, traces and callbacks are disabled; non-galaxie predictor
LMs and instance callbacks are refused.

The Worker installs an explicit hash-pinned closure without dependency resolution.
It omits `litellm`, `openai`, `gepa`, `tenacity`, `diskcache` and `cachetools`.
CPython resolves a metadata-only workspace `litellm==1.106.2` stand-in with no
importable module; accidental provider use fails closed. The existing cutoff and
pins, other frameworks' third-party wheel sets, goldens and matrices stay unchanged.
The [DSPy matrix](../../tests/conformance/compatibility-matrix-dspy.json) records
native CPython, Node Pyodide and headless Chromium evidence. The RAG DSPy program
chooses retrieval arguments from run input; with opt-in review it pauses before its
first model request, then streams a `ChainOfThought` answer with the shared citation projection.
It needs no model tool calling. Real-model format reliability, hands-on browser
verification and device performance remain unmeasured.

`linear` and `branching` also match the native Python stream events, mode order and
paths on Node Pyodide and real Chromium. Both lanes prove checked deltas and final
usage, cancellation after a checked delta, early public stream close followed by
terminal model settlement and another run, a mid-stream block with only the allowed prefix observed in Python, fixed
failures for non-JSON/oversized chunks, and stream-free event replay. Chromium keeps
the existing CSP and Trusted Types policy and blocks external requests.

### Offline-optimized program state

DSPy 3.4.1 JSON state from native `LabeledFewShot`, `BootstrapFewShot` with a
scripted LM, ReAct with demos on both predictors and an instructions-only
stand-in loads through `Module.load` on CPython, Node Pyodide and headless
Chromium. The seven separate state cases compare native transcripts, including
demo prompts, one capability tool call and fail-closed LM refusals. These are
scripted-model results; they say nothing about real-model answer quality or
MIPROv2, COPRO or GEPA output.

Save portable state offline with no LM attached (`module.set_lm(None)` then
`module.save('state.json')`). List `state.json` alongside the Python files in the
agent descriptor's `files`. In the bundled entry, construct the same program,
then load and bind in this order:

```python
from pathlib import Path
from galaxie.dspy import GalaxieLM

module.load(Path(__file__).with_name('state.json'))
module.set_lm(GalaxieLM('answer'))
```

Loading replaces each predictor's LM. A saved ordinary `dspy.LM`, or `lm: null`
without a subsequent `set_lm`, fails `unsupported` at prepare before any model
or external request. JSON state files are public build assets: never include
private data, user data or credentials. Their bytes carry the page bundle's
trust, like the Python agent sources; they have no independent integrity check.

Each downloaded source is capped at 1,048,576 UTF-8 bytes; exceeding that cap
fails `invalid` before a Worker starts. The complete boot frame has the same
bound, including all source text, JSON escaping and protocol fields; exceeding
it fails `unsupported`. Quotes and newlines amplify the encoded size. A 256 KiB
synthetic state loads in both Worker lanes. A 1,048,577-byte state fails the
per-file cap, and a 1,048,476-byte state fails the boot-frame cap in both lanes.

On 2026-11-10, on an Apple M5 Pro (macOS arm64), the Node Pyodide probe found
1,041,564 bytes accepted and 1,042,332 bytes refused (768-byte resolution) for
this test's sources and synthetic long demos. At the accepted size the model
request completed at 997,307 bridge bytes, leaving 51,269 bytes of headroom.
This is a sampled boundary, not a universal maximum: other source files,
escaping and demo shapes change both boot and model-request sizes. Model context
limits can reject a prompt even when it fits the bridge.

| State bytes | Worker boot to ready (ms) | `Module.load` (ms) | Outcome |
| --- | --- | --- | --- |
| 1,024 | 2,570.80 | 1.86 | Completed |
| 262,144 | 2,574.04 | 2.38 | Completed |
| 1,041,564 | 2,572.88 | 2.86 | Completed |

These are single-machine observations with local runtime assets and wheels,
possibly warm OS caches, and other tests running concurrently, not performance
claims or thresholds. Boot includes interpreter startup, wheel installation,
imports and program construction; load measures only `Module.load`. Chromium
load cost, other devices, Firefox and WebKit are unmeasured. Reproduce with:

```sh
GALAXIE_DSPY_STATE_MEASURE=1 pnpm exec vitest run --project node tests/conformance/dspy-state-limits.node.test.ts --silent=false --reporter=verbose
```

The executable round-trip catalog matches on all three lanes:

| State property | DSPy 3.4.1 behavior |
| --- | --- |
| Demos and instructions | Restored; demo objects become plain `dict`, and Pydantic demo values become dictionaries without their custom type. |
| Field metadata | Prefix and description are applied positionally, without saved field names. Reordering live fields silently misapplies them. ChatAdapter renders field names and descriptions, not the saved prefix. |
| Predictor LM | Replaced by the saved LM or `None`; always rebind the galaxie LM after loading. |
| LM class and endpoints | Custom LM classes raise `ValueError` by default. `api_base`, `base_url` and `model_list` are dropped unless unsafe LM loading is enabled; the ordinary saved LM still fails executor validation. Keep unsafe loading disabled. |
| Predictor config, tools and module code | Not reconstructed from state; the live config, tool functions and ReAct `max_iters` remain. Rebuild the same program before loading. |
| Missing/extra predictor keys | A missing key raises `KeyError` before changing the module; extra top-level keys are ignored by a module containing predictors. |
| Dependency versions | Saved Python, DSPy and cloudpickle metadata matches in these lanes. DSPy only warns on a mismatch; metadata is not a compatibility gate. |
| Pickle | `Module.load` of a `.pkl` path raises `ValueError` without `allow_pickle`; an agent descriptor listing `.pkl` fails `invalid` before fetching. `save_program=True` and `dspy.load` are outside this JSON path. |

Other DSPy versions and real-model optimizer output remain untested.

### Paused sessions and a changed state file

The replay journal compares a digest of each model request, capability call and
interaction request made before the pause. A changed state file fails
`unrecoverable` before any live model or capability call if it changes a journaled
request. The session then stays unrecoverable, including after restoring the
original file. A changed `state.json` is otherwise not detected: this guard belongs
to the journal, which does not fingerprint the state file automatically.

Eight scripted scenarios verify this on native CPython, Node Pyodide and headless
Chromium, with a page reload through IndexedDB in Chromium. Each program calls
`docs.lookup@1`, pauses for review, then calls `Predict`; `state-durable-early-model`
also calls `Predict` before the pause, `state-durable-late-model` does not, and
`state-durable-fingerprint` adds the file digest to the review props. The swaps use
`state-predict-demos` unchanged (`same`), `state-instructions-only` with changed
demos, instructions and field text (`prompt`), or `state-predict-demos` with changed
saved `train` examples and an identical prompt (`inert`).

All three `same` cases complete without repeating the earlier calls. `early-prompt`
fails `unrecoverable` and remains refused under the original state. `early-inert`
completes because the model request digest is unchanged. `late-prompt` also
completes: no journaled call depends on the old state, and the post-pause model call
uses the new state (zero demos and the saved offline instructions).

To bind a paused session to the exact state bytes, compute SHA-256 from the file
loaded at Worker boot and include it in the interaction props on every replay:

```python
import hashlib
from pathlib import Path
from galaxie.dspy import request_interaction

state_path = Path(__file__).with_name('state.json')
state_digest = hashlib.sha256(state_path.read_bytes()).hexdigest()
# Load this file and rebind the LM when constructing the program.
# Inside the program, publish the digest with the review request:
answer = request_interaction({
    'surfaceId': 'main',
    'viewRevision': 'first',
    'component': 'test.Review/v1',
    'props': {'stateDigest': state_digest},
})
```

This author pattern makes a changed file a journaled interaction difference.
`fingerprint-prompt` and `fingerprint-inert` both fail `unrecoverable` without live
calls and stay refused under the original state; `fingerprint-same` completes.
It does not add an independent integrity check to the public build assets. These
results cover DSPy 3.4.1 and scripted models only; Firefox, WebKit and real-model
behavior remain unmeasured.

## Google ADK (Python) agents

Select `framework: 'adk'` and executor `adk-python`, pinned to `google-adk` 2.12.0
([ADR-0022](../../docs/adr/0022-google-adk-python-through-the-pyodide-adapter.md)). The executor declares
`streaming`, `interrupts`, `resume` and `checkpoints` true and `subgraphs` false. Supply
`services.checkpoints: saver.byteRecords` and `recovery: saver.recovery` from the same scoped
`IndexedDBSaver` to restore a pending confirmation or long-running interaction after a reload.
The stored record is the ADK event log plus a per-session integrity key kept beside it; a changed
pending call, a spliced log or an unreadable record fails `unrecoverable`, and the key gives no
protection against a writer who can change both (ADK's check covers function-call arguments, not
deleted or reordered history). A record must fit one 1 MiB bridge frame (about 719 KB raw): a
run that would exceed it fails `unsupported` before the next model or tool dispatch. Without a
recovery store, host writes still repeat after a restore. See the
[unsupported list](../../docs/unsupported.md) for the supported agent shapes and limits.

### Authoring surface and supported shapes

The agent module exports an entry factory (`entry` in the `PyodideAgent` descriptor) that returns
an ADK agent tree or `galaxie.adk.Executor(agent, interaction=..., resume=...)`. Authors import
`llm(role)` for a router-backed model, `capability_tool(name, capability, parameters, description,
require_confirmation=False, long_running=False)` for a tool that calls a bound capability, and
`loop_exit()` for a `LoopAgent` without `max_iterations`. They never see the Runner, the session
service or a credential; `interaction(requests)` turns a pause into one interaction and an optional
`resume(requests, action, payload)` returns one decision per request.

The tool helpers of every Python framework (`galaxie.adk`, `galaxie.dspy`,
`galaxie.pydantic_ai`) mark their capability calls as model-chosen. The adapter then refuses a
capability that is not a read unless it is bound with `approval: 'confirm'` and the runtime has
host confirmation coverage for it, and it refuses a name with no binding. The refusal is the fixed
`invalid` error and the capability does not run. The ADK helper returns it to the model as a
fixed message; the DSPy and pydantic-ai helpers end the run with that error. A direct `galaxie.capabilities.call(...)` from
agent code is not a model-chosen call and is unchanged. A tool you write yourself that calls
`capabilities.call` without `tool=True` is outside this check.

The conformance cases show these shapes with the same results as native ADK 2.12.0: a single
`LlmAgent`, a `SequentialAgent`, a `ParallelAgent` (inside a sequence), a `LoopAgent`, and an
`LlmAgent` with `sub_agents` that transfers with `transfer_to_agent`, each for run and stream, and a
confirmation in any child of a `SequentialAgent` (including nested sequences), a long-running
middle child and one confirming branch under each `ParallelAgent`, also across a reload on Node.
Newly enabled pause positions use ADK resumability; original last-child sequences keep their
runner. Loop pauses remain refused because native resumability repeats an earlier writer's
finished tool. Resumable apps refuse duplicate agent names, `temp:` output keys and `LlmAgent`
transfer children. Two parallel branches
that call write capabilities keep branch-local replay scopes; recovery tests count one host
invocation per write across reload, reversed arrival and failed-resume retry. `Workflow`, `AgentTool` and every
pause shape the [unsupported list](../../docs/unsupported.md#google-adk-python) names fail
`unsupported` at prepare. `subgraphs` stays false.

### Third-party licenses

The 29-wheel `adk` set carries the licenses its wheels declare in their dist-info metadata:

- Apache-2.0: `google-adk` (declared by classifier), `google-genai`, `google-auth`, `tenacity`, `opentelemetry-api`, `opentelemetry-semantic-conventions` and `requests` (which ships a `NOTICE` file).
- `Apache-2.0 OR BSD-3-Clause`: the vendored `cryptography` 50.0.2 WASM wheel, with `LICENSE`, `LICENSE.APACHE`, `LICENSE.BSD` and the linked dependencies' license texts in its `dist-info/licenses`. It statically links OpenSSL 4.0.3 (Apache-2.0). See the [artifact provenance and verification](../../python/wheels/README.md).
- `Apache-2.0 OR BSD-2-Clause`: `packaging`. `MIT OR Apache-2.0`: `sniffio`.
- BSD-3-Clause: `authlib`, `joserfc`, `websockets`, `starlette`, `httpx`, `idna` and `pycparser`.
- MIT: `fastapi`, `annotated-doc`, `annotated-types`, `anyio`, `cffi`, `charset-normalizer`, `pydantic`, `pydantic-core`, `typing-inspection` and `urllib3`.
- MPL-2.0: `certifi`. PSF-2.0: `typing-extensions`.

Hosts that serve the wheels keep each wheel's `dist-info` license and notice files with it.
