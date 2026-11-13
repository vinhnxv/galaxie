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
including other Python frameworks' tool-bound calls and schema calls. The closed Python bridge has no caller
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

### LangGraph Python model-chosen calls through text

The November 2026 spike records **alternative** for binding/replies, streamed
replies, confirmed writes, the safety floor and durable replay. It ships no
`galaxie.langchain.capability_tool` or `bind_tools` implementation. The
[execution-identity rerun](../../docs/adr/0018-python-agents-through-pyodide.md#execution-identity-rerun-2026-11-13)
records **refused**: a test-local driver scope preserves swallowed terminal codes,
but read effect IDs change on replay and abrupt loss before a tool checkpoint has
no public saved-step retry path. An already parked sibling confirmation can still
invoke its host write after a failure latch. The unchanged
proxy refuses tool history as `unsupported` and reply tool parts as `invalid`;
inherited `bind_tools` raises `NotImplementedError` in CPython. The Worker maps an
uncaught bind failure at boot to `unavailable`, or during a run to `executor_error`.

Use an ordinary node with a routed text model, validate a small JSON request
against author-owned names and argument shapes, then await the broker directly:

```python
import json
from galaxie import GalaxieError, capabilities
from galaxie.langchain import GalaxieChatModel

async def choose_and_read(state, config):
    reply = await GalaxieChatModel(role='answer').ainvoke(state['prompt'], config)
    try:
        request = json.loads(reply.content)
        if (not isinstance(request, dict) or set(request) != {'name', 'value'}
            or request['name'] != 'read' or type(request['value']) is not int):
            raise ValueError()
    except (TypeError, ValueError):
        raise GalaxieError('invalid') from None
    result = await capabilities.call('read@1', {'value': request['value']}, config)
    return {'result': result}
```

Keep terminal failures uncaught. Bind significant writes with `approval: 'confirm'`
and host confirmation coverage; the broker still freezes arguments and waits for
host approval. In this recipe a decline ends `denied`, rather than returning the
candidate helper's fixed denial text to a model loop. No `ToolNode`,
schema-constrained tool choice or streamed tool deltas are supplied. For streamed
JSON text, collect the checked text before parsing. Persist plain JSON strings;
convert LangChain's `message.text` accessor with `str(...)` before storing it.
Calls in one JSON request run sequentially. Pass full node config and keep call
order deterministic for recovery; the measured write-node replay runs the host
write once across a fresh Worker restore with byte checkpoints and recovery.

Direct calls omit the helper's `tool: true` binding-policy check. Trusted authors
own the static allowlist and write-binding setup; grants, validation, labels,
budgets, output checks, host confirmations and the effect journal remain in
JavaScript. Plain native models and direct trusted capability calls are outside
the candidate guard. Plain tools, arbitrary binding forms and multimodal/tool
message neighbours remain **refused** on this proxy. Scripted CPython tests compare
the replacement with native tool-call loops; Node Pyodide additionally exercises
host confirmations, budget termination, private-result destination refusal and
fresh-Worker restore/replay. New Chromium reload, Firefox, WebKit and real models
are unmeasured. See the [gate record](../../docs/adr/0018-python-agents-through-pyodide.md#langgraph-python-tool-call-replies-spike-2026-11)
and [executable evidence](../../tests/conformance/README.md#langgraph-python-tool-call-replies-spike).

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
usage without repeating text. Native LangGraph Python tool-call parts and multimodal
messages remain unsupported; the text-protocol replacement below is measured.
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
without provider SDKs. Use `GalaxieModel(role)` for routed model calls,
`capability_tool(...)` for broker-bound tools and `run_child(ctx, agent, prompt, ...)`
from `galaxie.pydantic_ai` for delegation inside a tool. JavaScript checks reply text,
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
scope, logout fencing and ownership composition.

**Delegation.** `await run_child(ctx, child, prompt, key='')` returns the child's
`AgentRunResult`. It defaults `deps` to `ctx.deps` (an explicit override is allowed),
shares `ctx.usage` and `ctx.usage_limits`, and gives each child a fresh native-output
repair counter. The parent and siblings keep their own counters; permitted repairs
still consume the host's shared run repair budget. The child's conversation ID is
a hash of a domain tag, parent conversation ID, delegate message position, part
index and `key`. It does not use the provider's tool-call ID. Keep replay call
order and structure deterministic, and use distinct keys for several children in
one tool body. Reusing a child identity within one executor run fails `invalid`.

The helper reserves `usage`, `usage_limits`, `conversation`, `conversation_id`,
`run_id`, `infer_name`, `metadata`, `workspace` and `spec`; passing any of them, or an
option `Agent.run` does not accept, fails `invalid`. The child model,
including a `model=` override, must be a `GalaxieModel`, or it fails `unsupported`.
Agent overrides and capability model selections are checked at run and request
time. Child streaming enabled by event handlers or capabilities is also refused
before a child model request reaches the bridge.
The existing instrumentation, native-tool and model-setting refusals also apply.

During an `Executor` run, the guard accepts the parent and registered helper
children. Plain nested `child.run`, `child.run_stream`, capability tools from an
unregistered run and nested `Executor.run` fail `unsupported` before bridge work.
The checks use public pydantic-ai run and request contexts. Run IDs are revoked
when the parent finishes, fails or is cancelled, including in inherited background
task contexts. A model request is authorized by the capability of the run that
makes it, never by `run_id` stamps in message history, so a prompt-less nested run
that inherits the parent's history is refused like any other plain nested run.
Ordinary retries, resume, sequential top-level runs and parallel tools pass the
measured checks.
Outside an `Executor`, direct model/helper use remains available without the guard.
The guard is accident-proofing, not an isolation boundary: direct trusted
`capabilities.call`, plain non-`GalaxieModel` children and work started in a thread or
task with an empty context (for example `run_in_executor` with a fresh event loop)
can bypass it. ADR-0012
controls remain in the JavaScript bridge and broker.

The [delegation evidence](../../tests/conformance/README.md#pydantic-ai-agent-delegation-probes)
covers CPython and Node Pyodide probes plus six headless Chromium conformance cases
with scripted models. In the Node recovery probe, after a crash following a child
write, a scripted changed delegate ID preserves the helper's child scope and effect ID, so the write
runs once; the ID-sensitive control writes twice. This measures sensitivity to ID
changes, not whether a real provider regenerates IDs. Writes still require host
confirmation and matching checkpoint/recovery stores. `subgraphs` stays false (probe S1):
there is no helper child streaming or host child stream path, and plain child
streams are refused; Python wire tests, a driver tripwire and Node stream assertions
pin this rule. Delegation and child approval are measured in headless Chromium,
including real reloads with reopened IndexedDB. Firefox, WebKit, real providers,
arbitrary mid-run continuation and general nested checkpoints remain unmeasured.
The size budget covers JavaScript package entries; neither this adapter nor the Python wheel has
a size budget.

**Child approvals.** Set `hoist_approvals=True` to pause the parent when a child
needs approval. Both agents must allow `DeferredToolRequests` in their output
types, for example `[str, DeferredToolRequests]` or `str | DeferredToolRequests`.
The child uses ordinary `requires_approval` tools. The helper returns its usual
`AgentRunResult` after the child finishes; with the flag set, its output is never
`DeferredToolRequests`. Without the flag, a returned deferral remains tool data.

For a parent and child configured with `[str, DeferredToolRequests]`, wire the
parent tool and interaction factory as follows:

```python
from pydantic_ai import DeferredToolRequests, RunContext
from galaxie.pydantic_ai import Executor, hoisted_child_requests, run_child

@parent.tool
async def delegate(ctx: RunContext) -> str:
    result = await run_child(ctx, child, 'Save the requested record.', hoist_approvals=True)
    assert not isinstance(result.output, DeferredToolRequests)
    return result.output

def interaction(requests):
    children = hoisted_child_requests(requests)
    def show(call):
        return {'id': call.tool_call_id, 'name': call.tool_name,
                'arguments': call.args_as_json_str()}
    return {
        'surfaceId': 'main', 'viewRevision': 'approval-1',
        'component': 'app.Approval/v1',
        'props': {'calls': [{
            **show(call),
            'child': [show(pending) for pending in children[call.tool_call_id].approvals]
                     if call.tool_call_id in children else [],
        } for call in requests.approvals]},
    }

executor = Executor(parent, interaction=interaction)
```

`hoisted_child_requests` returns the validated child requests keyed by the parent
delegate's tool-call ID. Props must contain the child's `id`, `name` and matching
`arguments` together in one object, nested anywhere under `props`. Arguments may
be a JSON string or JSON object; render them as data. The executor refuses a
missing or changed child call before publishing or restoring an interaction.
The host's component must display those fields to the user. The child's broker
write confirmation remains a separate host gate at execution.

The default answer still names the parent's approval IDs:
`{ "toolCallIds": ["delegate-call-id"] }`, with action `approve` or `deny`.
Approval re-enters the tool and resumes the saved child using its own registered
run and shared usage and limits. Denial returns `The tool call was denied.` for
the delegate without running the child again. No custom resume callback is
needed. If one is supplied, the executor overwrites its hoisted state with the
validated state for approved calls and drops that state on denial. A child that
asks again produces a new interaction. If the delegate tool itself has
`requires_approval=True`, there are two pauses: approve the delegate first, then
approve the child's call; neither pause executes the child's gated body.
Interaction and resume callbacks receive copies of requests. A resume callback
that adds reserved child metadata to a call without a validated hoist fails
`invalid`.

A child pending call ID that equals a pending ID of the parent fails `unsupported`.
A plain child sibling tool that returns extra user content (`ToolReturn` with `content`)
is also refused after it ran, because its trailing request is not an accepted shape.
A pause supports one hoisted child with exactly one pending approval and no
external calls. Several hoisted children, several child approvals, `CallDeferred`
child calls, nested hoists and child state over 128 KiB fail `unsupported` without
publishing an interaction. Hoisting outside an executor also fails `unsupported`.
The flag reserves `message_history` and `deferred_tool_results`, requires a known
output type containing `DeferredToolRequests`, and limits `key` to 128 characters;
misuse fails `invalid` before child work.

Use at most one hoisting child over a tool body's whole execution, and put it
first. A second is refused with `invalid` before that second child's request or
write. When code reaches it only after the first child resumes, the first
approved write may already have happened. Children run before a hoist can replay
when the tool re-enters. Keep all call order and structure deterministic.

The executor validates the reserved `galaxie.child-approval` entry at publication,
restore and re-entry, including its positional identity, code-side key and pending
call. Failures use fixed `unsupported`, `unrecoverable` and `invalid` errors,
respectively. Unrelated author metadata is not validated. Snapshots are not
authenticated: a checkpoint-store writer can forge parent or child state. The
parent checkpoint and pending display must still fit one 1 MiB bridge frame after
encoding; the 128 KiB child-state cap does not bound arbitrary parent history.

The [child approval evidence](../../tests/conformance/README.md#pydantic-ai-child-approval-hoist)
uses scripted CPython and Node Pyodide cases for approve, reject and fresh-Worker
restore. Each approved fixture writes once and rejection writes nothing. CPython
compares effect scopes across replay attempts; a Node crash-after-write replay
of the hoisted resume remains unmeasured. ADR-0012 controls stay in JavaScript.

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

Thread-pool fan-out through `dspy.Parallel` or `dspy.Evaluate` is refused with
fixed `unsupported`: the Worker cannot start threads, and a synchronous LM entry
cannot await the bridge. Sequential `await module.acall(...)` loops remain valid;
use the keyed helper below for concurrent async calls.

`streaming`, `interrupts`, `resume` and `checkpoints` are true; `subgraphs` is
false. Nested modules have no checkpoint namespaces, interrupt propagation or
nested stream paths: a pause unwinds the whole program. Sync entry points are
**refused**; model-calling runtime optimizers have an **alternative** through
offline JSON state; runtime `LabeledFewShot` is **supported** with an LM rebind in
the measured native/Node shapes. See the [runtime recipe and limits](#runtime-optimizers-and-the-offline-recipe).
Provider-string LMs, native provider schema output and service retrievers each
have an **alternative**; embeddings are **refused**. Multimodal inputs remain
unsupported. See the [provider recipes and limits](#provider-strings-schema-output-embeddings-and-retrievers). Offline-optimized JSON state has the scripted evidence and limits
[below](#offline-optimized-program-state).

Use the shipped helper for concurrent async calls:

```python
from galaxie.dspy import branches

answers = await branches({
    "summary": lambda: summarize.acall(document=document),
    "keywords": lambda: keywords.acall(document=document),
})
```

The input is a mapping of unique keys to zero-argument callables returning
awaitables; results keep input order. Keys match `[A-Za-z0-9_.-]{1,64}`. A group
holds at most 32 branches, and a run at most 1000 non-empty groups. Empty groups
return `{}` without journaling. Each branch must await its journaled calls
sequentially. Code outside journaled calls must be deterministic.

Branch identity uses group order, the author key and the branch-local call
ordinal. Replay after a pause matches those markers without new requests for
the joined group, independent of arrival order and DSPy's thread hops. Branch
capability calls keep distinct effect scopes and can reuse host write receipts
after Worker loss. Pause only after the join: interaction requests inside branches,
nested groups and streaming with branches end fixed `unsupported`. Root journaled
calls during a group and overlapping journaled calls inside one branch are refused
only when the overlap is observed in flight; otherwise a later resume can end
`unrecoverable`, so await each branch's calls sequentially. Native-only tests pin
that two concurrent terminal failures report the first recorded code rather than
the first in input order, and both siblings drain.

Removing/renaming a recorded key, changing a request or adding a journaled call
on replay ends `unrecoverable` before dispatch. Earlier rows stay unchanged and
the driver appends one compact poison checkpoint. A divergent paused fan-out
cannot resume even after the original program returns; the user starts over.
Malformed stored markers fail before registration and add no row. Metadata stays
`v: 1`; older libraries refuse fan-out records until newer code returns. Records
without fan-out keep their original bytes. See the [shipped helper evidence](../../tests/conformance/README.md#shipped-async-branch-helper).

Threaded verbatim calls, including the default thread count, now end fixed
`unsupported` in native CPython and Node Pyodide, with zero model or capability
requests. With one thread both still end `unsupported`. Raw author-created threads
are not attributed natively, and a thread-start error caught by author code is
invisible to the executor. See the [shipped refusal evidence](../../tests/conformance/README.md#dspy-thread-pool-fan-out-refusal).
The six thread-pool probes also pass on local Chromium, Firefox and WebKit.
The [engine measurements](../../tests/conformance/README.md#dspy-engine-measurements)
add Firefox/WebKit live fan-out goldens and reload. A same-day test-preview fix
passes Firefox's unchanged CSP-header equality checks: middleware sets the
identical header before Vite's 304 shortcut, guarded by a wire-level test.
Plain single-call `asyncio.gather` replays in the measured
Node cases but fails natively; multi-call re-dispatch can repeat a write before
`unrecoverable`. Author code must be deterministic apart from journaled calls.
Chromium, Firefox, WebKit, real models, other DSPy versions and successful streaming,
nested or pausing fan-out and ReAct branches are unmeasured by this spike. See the
[evidence and exact limits](../../tests/conformance/README.md#dspy-parallel-and-threaded-evaluate-spike).

JSONAdapter works without streaming; native provider schema output has an
**alternative** through typed signatures with Python-side validation. Verbatim
provider `response_format` ends `unsupported` before a model request. The default ChatAdapter disables JSON fallback, since a
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
importable module; LiteLLM-dependent calls fail without it. A provider LM
constructed after prepare is not blocked by predictor validation; the native
engine uses its own transport outside the router, as measured below. The existing cutoff and
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

### Runtime optimizers and the offline recipe

The 2026-11-11 [runtime spike](../../tests/conformance/README.md#dspy-sync-entry-points-and-runtime-optimizers-spike)
records three outcomes on DSPy 3.4.1, CPython 3.14.5, Node 24.15.0 and Pyodide
314.0.7, with scripted models only:

- Sync entry points: **refused**. `rt-sync-forward-only` refuses at prepare;
  `rt-sync-module-call`, `rt-sync-forward-call`, `rt-sync-lm-call`,
  `rt-sync-swallowed` and `rt-sync-to-thread` end `unsupported`, with zero model
  or capability requests in both lanes. Use `aforward` and `await module.acall(...)`.
- Model-calling runtime optimizers: **alternative**. `rt-opt-bootstrap`,
  `rt-opt-mipro` and `rt-opt-copro` end `unsupported` in both lanes.
  `rt-opt-gepa` ends `unsupported` natively and `executor_error` in the Worker,
  where `gepa` is absent. All make zero requests; optimize offline instead.
- Runtime `LabeledFewShot`: **supported** for `rt-opt-labeled` and
  `rt-opt-labeled-two-stage`. Rebind `compiled.set_lm(GalaxieLM('answer'))` after
  `dspy.LabeledFewShot(k=2).compile(...)`, then `await compiled.acall(...)`.
  Output, request payloads, seeded demos and fresh-Worker replay match the native
  reference. `rt-opt-labeled-naive` omits the rebind and ends `executor_error`
  with zero requests: `reset_copy` clears the predictor LM.

The sync refusal remains terminal even when author or optimizer code catches
`Exception`. The earlier parallel spike measured that the Worker cannot start
threads. A blocking bridge call would stall the event loop that delivers its
reply and handles cancellation and budgets; that consequence is reasoning,
not a new measurement. No core contract change or shipped source edit was needed.
Author code must be deterministic apart from journaled calls.

For model-calling optimizers, or to avoid shipping a large runtime trainset:

1. Build the same program with `aforward` and its predictors.
2. On native CPython, optimize offline with your own LM and trainset. The verified
   examples use scripted models; real-model quality is unmeasured.
3. Call `module.set_lm(None)`, then `module.save('state.json')`. Use JSON state
   only, never `save_program=True`.
4. Review the JSON as a public build asset: include no private data or credentials.
   Keep within the [per-file and boot-frame bounds](#offline-optimized-program-state).
5. List the state file in the agent descriptor's `files`.
6. Construct the same program in the entry, `module.load(...)`, then
   `module.set_lm(GalaxieLM('answer'))`, as in the load snippet above.
7. Ship a new file after re-optimization. Paused sessions bound to the old JSON
   bytes [refuse restore before requests](#paused-sessions-and-a-changed-state-file).
8. Compare the shipped program with a native run using scripted replies.

| Offline state producer | Verification |
| --- | --- |
| `LabeledFewShot`, scripted-LM `BootstrapFewShot`, ReAct demos, instructions-only stand-in | Existing seven state cases on native CPython, Node Pyodide and headless Chromium; native/Node regression gates rerun here. |
| `MIPROv2`, `COPRO`, `GEPA` | Offline output unmeasured; the runtime refusals above do not establish state round trips. |
| `KNNFewShot`, `Ensemble`, `SIMBA`, `BetterTogether`, fine-tuning optimizers | Runtime and offline output unmeasured. |

Chromium, Firefox and WebKit runtime probes, real models, other DSPy versions and
optimizers given an in-Worker plain `dspy.LM` remain unmeasured. Runtime support
here is measured shipped behavior, not a new golden conformance family.

### Provider strings, schema output, embeddings and retrievers

The 2026-11-11 [provider spike](../../tests/conformance/README.md#dspy-provider-strings-schema-output-embeddings-and-retrievers-spike)
records provider-string LMs **alternative**, native provider schema output
**alternative**, embeddings **refused** and service retrievers **alternative** on
DSPy 3.4.1, CPython 3.14.5, Node 24.15.0 and Pyodide 314.0.7. These are scripted
native/Node observations; no verbatim API gains new shipped support or a core
contract change.

| Author's provider string | Agent binding | Host responsibility |
| --- | --- | --- |
| `dspy.LM('openai/gpt-4o')` | `GalaxieLM('answer')` | Declare `answer` in the agent definition's `models`; map that role to the provider and model in host routing configuration. |

Bind predictors as in [DSPy programs](#dspy-programs); do not construct a provider
`dspy.LM` in agent code. Sampling parameters such as `temperature` and `max_tokens`
belong to the host's router configuration. `pe-control-routed` has plain-DSPy
output and payload parity; `pe-lm-kwargs` ends `unsupported` with zero requests.

In DSPy 3.4.1 provider strings default to the native lm15 engine, **not LiteLLM**.
The native engine defaults to sockets even in Pyodide; its optional
`FetchTransport` is not selected automatically. A predictor-bound foreign LM is
refused at prepare (existing `refused-lm`), but `pe-lm-runtime-set` and
`pe-lm-runtime-context` construct one after prepare and bypass that validation.
Each attempts one rejected loopback connection natively and ends `executor_error`
with zero bridge requests. In Node both end `executor_error` with zero recorded
fetch attempts. This does not establish network containment: the router's grants,
budgets and destination policy do not cover this path. It is the trusted-code
limit in [ADR-0018 decision 9](../../docs/adr/0018-python-agents-through-pyodide.md#decision).
The syntax-only lint flags literals, not arbitrary runtime construction.
`pe-lm-runtime-nokey` ends `executor_error` before I/O in both lanes.

For typed output, declare types in the signature and use ChatAdapter with JSON
fallback disabled, or non-streaming JSONAdapter:

```python
from typing import Literal
import dspy
from galaxie.dspy import GalaxieLM

class Answer(dspy.Signature):
    question: str = dspy.InputField()
    answer: Literal['done', 'other'] = dspy.OutputField()

predict = dspy.Predict(Answer)
predict.set_lm(GalaxieLM('answer'))
# Inside aforward, under the Executor's adapter:
reply = await predict.acall(question=question)
```

DSPy validates typed fields after receiving the reply. `pe-schema-typed-ok`
matches plain DSPy with one request and no `jsonSchema`; the `int` violation in
`pe-schema-typed-violation` ends `executor_error` after one request, without retry.
This is a weaker guarantee than provider-constrained decoding. Verbatim
`response_format` ends `unsupported` with zero requests. The router's
structured-output feature is already used by pydantic-ai `NativeOutput`; mapping
DSPy to it remains implementation work. The native-only
`pe-schema-candidate-shape` records a normalized `json_schema` dictionary holding
an object schema and the open-mapping `{'type': 'json_object'}` fallback.

Embeddings are **refused**: `pe-embed-hosted-string`, `pe-embed-callable` and
`pe-embed-retriever` end `executor_error` without requests or egress. Hosted
strings need absent LiteLLM; even pure-Python callables need absent NumPy during
postprocessing. NumPy/FAISS are outside the pinned closure; adding them changes
the lock and wheel set. Router modalities are `text` and `decision`, and
[ADR-0019](../../docs/adr/0019-in-browser-retrieval.md) exposes passages rather than
vectors. For semantic search use host-bound retrieval:

```python
from galaxie.capabilities import call

# Inside aforward; the host declares and binds the narrow read capability.
result = await call('docs.search@1', {'query': question, 'mode': 'hybrid', 'k': 10})
passages = result['passages']
```

Alternatively bind `galaxie.dspy.capability_tool(name, description, args_schema)`
as a ReAct tool. The [RAG agent](../../examples/rag-browser/agent_py/rag_dspy/agent.py)
and its native/Node regression suites demonstrate `docs.search@1` plus routed
generation; broker grants, destination policy, budgets and labels apply there.
`pe-retrieve-local-rm` returns bundled passages with no requests, but represents
an author's local corpus. `pe-retrieve-colbert` ends `executor_error` without
bridge requests; native `requests` attempts one rejected loopback connection,
while Node records zero fetch attempts locally on macOS and one rejected
`127.0.0.1:9` fetch in Ubuntu 24.04 CI (Node 24.22.2; CPython 3.14.6 for native
references, versus Node 24.15.0/CPython 3.14.5 locally). Both end with the same fixed code and no
unexpected target. The exact transport difference is unmeasured. Direct service
access is outside the broker; the Worker attempt requires a follow-up decision
on fail-closed handling under ADR-0018 decision 9. This probe does not establish
XMLHttpRequest reachability or real-service behavior.

`pe-env-facts` finds `requests` in both lanes, `httpx` and `openai` only natively,
and no `litellm`, `numpy` or `faiss` in either. A package being in the shared lock
does not imply it is installed in the DSPy closure. New Chromium, Firefox and
WebKit probes, real models/services, other DSPy versions, `engine='litellm'`,
`dspy.lm15.register_provider` declarations, Databricks/Weaviate retrievers,
vector-returning capabilities, undeclared-role refusal and multimodal inputs
remain unmeasured. Existing Chromium golden/RAG evidence is reused only where
previously measured; see the evidence ledger.

### Paused sessions and a changed state file

Durable DSPy Workers automatically bind paused sessions to the descriptor's JSON
files. Before importing the author's entry, the driver freezes a SHA-256 manifest
of sorted relative JSON paths and the bytes Python can read. Only paused records
carry the optional `stateBinding` metadata key. Changed or removed JSON refuses
restore with `unrecoverable` before any live model call, capability call or replay;
checkpoint rows, pending writes and effects stay unchanged. Restoring the original
bytes lets the session resume with one replay notification and no repeated effect.
This is a consistency check against accidental swaps, not integrity protection:
checkpoint metadata is unauthenticated and can be forged or stripped by a writer.

Every descriptor `.json` file counts, including whitespace and unused training or
configuration data; paths with a `__pycache__` component are ignored. An edit to
any descriptor JSON file refuses earlier bound pauses until the original bytes
return. Keep volatile non-state data outside descriptor JSON. Python sources are
excluded. The Worker strips a UTF-8 BOM when decoding sources, so the digest covers
those decoded bytes rather than the bytes served over HTTP. The digest stays
frozen for the Worker lifetime.

Programs without JSON keep byte-identical metadata and checkpoints. Completed
(compact) and unrecoverable records never carry the key; a completed session can
start a new run under changed state. New code accepts legacy unbound records. The
metadata version stays `v: 1` and the byte type tags stay unchanged. Older library
code refuses bound records without writing; rolling back the library leaves those
pauses unreadable until the newer code returns. A legacy session that pauses again
gains the current binding (measured natively and on Node, Chromium, Firefox and
WebKit after the test-preview header follow-up).

The key adds exactly 82 JSON bytes, about 110 base64 characters, to a paused row.
The existing 1 MiB bridge check counts it, leaving about 110 bytes less pause
headroom; an oversized pause fails `unsupported` before publication. An unreadable
descriptor JSON file fails durable boot with `unsupported` instead of binding a
partial manifest. Non-durable Workers do not scan or bind files. No extra file-count
or byte cap is imposed; large many-file descriptors remain unmeasured.

Eight earlier scripted swap scenarios retain their outcomes on native CPython,
Node Pyodide and headless Chromium, with IndexedDB page reloads in Chromium.
Changed-state cases run on legacy, unbound records; identical-state cases also
exercise bound records on Node and Chromium.
Each calls `docs.lookup@1`, pauses, then calls `Predict`. The early-model program
also calls `Predict` before the pause; the fingerprint program adds a file digest
to review props. All three `same` cases complete. `early-prompt` fails and poisons
later restores, even under the original state; `early-inert` and `late-prompt`
complete because the journaled requests are unchanged. The author fingerprint
refuses both prompt and byte-only changes. These legacy outcomes remain unchanged.
Automatic-binding probes separately cover identical bytes, changed prompts, unused
JSON changes, legacy acceptance and non-sticky original-byte rollback.

#### Author fingerprint for Python sources and other files

To bind Python sources or anything outside descriptor JSON, compute a fingerprint
at boot and include it in interaction props on every replay. Choose the file or
manifest the program depends on; this example fingerprints its own Python source:

```python
import hashlib
from pathlib import Path
from galaxie.dspy import request_interaction

source_digest = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
# Inside the program, publish the fingerprint with the review request:
answer = request_interaction({
    'surfaceId': 'main',
    'viewRevision': 'first',
    'component': 'test.Review/v1',
    'props': {'stateDigest': source_digest},
})
```

This makes a changed file a journaled interaction difference. The native state-file
recipe still completes with identical bytes under automatic binding; the legacy
`fingerprint-prompt` and `fingerprint-inert` cases refuse without live calls and
remain refused under the original state. The recipe adds no independent integrity
check to public build assets.

Measured with DSPy 3.4.1 and scripted models on CPython, Node Pyodide and Chromium.
Later local [engine measurements](../../tests/conformance/README.md#dspy-engine-measurements)
add WebKit binding and legacy re-pause on Node/Chromium/Firefox/WebKit. The
same-day preview-header follow-up passes all 11 Chromium, 22 Firefox and 22 WebKit
engine tests locally, with no CSP-header mismatches and the policy unchanged;
production hosting uses generated `_headers`. Real models, concurrent tabs, forged metadata and large many-file
descriptors remain unmeasured; the other-version attempt could not collect tests. See the
[spike record and shipped evidence](../../tests/conformance/README.md#dspy-paused-session-state-binding-spike).

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
finished tool. Every app refuses repeated agent names at prepare; resumable apps also refuse `temp:` output keys and `LlmAgent`
transfer children. Two parallel branches
that call write capabilities keep branch-local replay scopes; recovery tests count one host
invocation per write across reload, reversed arrival and failed-resume retry. `Workflow`, `AgentTool` and every
pause shape the [unsupported list](../../docs/unsupported.md#google-adk-python) names fail
`unsupported` at prepare. `subgraphs` stays false.

### Porting ADK models and static toolsets

See the [ADK models-and-tools guide](../../docs/guides/adk-models-and-tools.md) for tested declared-role and fixed-toolset examples across executors.

The [host inventory outcome](../../docs/adr/0020-google-adk-through-an-adapter.md#host-role-inventories-for-model-strings-and-fixed-toolsets-2026-11)
adds exact declared-role strings and fixed capability toolsets. With `answer` in
the host's existing role declaration, `model='answer'` uses the same router-backed
model type as `llm('answer')`. Unknown, case/whitespace variants, display names,
Gemini objects and foreign models fail fixed `unsupported` at prepare, before
model, capability or store access. The whole tree is validated before assignment;
a failed assignment restores its original model fields.

The optional ADK-only boot inventory contains at most 256 roles of 1–128 characters.
The host omits invalid-length roles and takes the first 256 remaining declarations;
strings naming omitted roles stay refused. Duplicate inventory entries refuse
`unsupported`; malformed boot inventories fail `invalid`. A mapped role whose
`galaxie/<role>` display name satisfies ADK's Gemini predicate is refused. Prefer
names such as `answer`; the explicit `llm(role)` helper keeps its existing behavior.

Omission produces no host-visible error: a string naming an omitted role fails
`unsupported` at prepare. A repeated role in a hand-built boot payload fails the
whole boot `unsupported`; a failed declaration preserves the previous inventory.
Model strings must be exact `str` values. ADK normalizes `StrEnum` members and
plain `str` subclasses during construction; a subclass assigned afterwards is
refused at prepare before any model field is replaced.

```python
from google.adk.agents import LlmAgent
from galaxie.adk import capability_tool, toolset

SPECS = [('search', 'docs.search@1', {'type': 'object', 'properties': {'q': {'type': 'string'}}, 'required': ['q']}, 'Search documents.')]

def create():
    return LlmAgent(name='root', model='answer', tools=[toolset([
        capability_tool(name, capability, parameters, description)
        for name, capability, parameters, description in SPECS
    ])])
```

Each prepare boots an independent Worker and interpreter; sequential or concurrent
prepares of the same sources do not share author objects. The role declaration is
trusted Python configuration, not an isolation boundary. `toolset` copies a non-empty
list of this boot's capability tools, expands at its position and preserves the
existing pause rules. Empty, nested, foreign, control-tool and duplicate-name groups
(including collisions with flat tools) fail `unsupported`.

Keep the table static and construct tools inside the entry factory. MCP-backed
entries use the host's `tools-mcp` bindings. Per-turn dynamic lists and network
toolsets have no proven replacement. Provider-native network tools, code executors
and both planners remain **REFUSED**: provider tool config is rejected before the
bridge; thinking config is omitted; instruction text does not reproduce PlanReAct
final retagging under the same script. Use a narrow host-bound read capability for
network data as general guidance, not as this spike's same-script alternative.
Scripted CPython and Node Pyodide tests cover these inventories and reload behavior.
Firefox, WebKit, real models and devices remain unmeasured for this addition.

### ADK message attribution

The [stream namespace spike](../../docs/adr/0020-google-adk-through-an-adapter.md#stream-namespaces-workflow-agents-and-subgraphs-spike-2026-11)
records an **alternative** for messages: build a host-owned lookup from globally
unique names in the same static agent tree. In the host's event loop:

```ts
const paths = new Map([['drafter', ['sequence', 'drafter']]]);
if (event.type === 'stream' && event.executor === 'adk-python' && event.mode === 'messages') {
  const displayPath = paths.get((event.data as { author: string }).author);
  // Render displayPath in the host's own UI.
}
```

The [duplicate-identity outcome](../../docs/adr/0020-google-adk-through-an-adapter.md#duplicate-identity-measured-outcome-2026-11-13)
now refuses every repeated agent name, including the root, with `unsupported`
at prepare before model or store access. Rename agents in a fresh tree; names
compare exactly, including case and Unicode normalization. Message attribution is
unambiguous for every tree that prepares. Older duplicate-tree pauses can no
longer prepare; renaming does not migrate their stored authors. Unique-name pause
records restore unchanged. The new refusal is measured in CPython and Node Pyodide.
Tool/paused markers have no author, Parallel interleaves, and node_info.path is
empty under Sequential/Parallel/Loop roots. Standalone LlmAgent transfer roots can
carry node paths, which are not a universal identity oracle. Event paths stay
empty, effect scopes stay positional, PendingInteraction has no path and no
namespace is stored; `subgraphs` stays false. Dedicated nested-path browser
behavior, Firefox, WebKit and real models remain unmeasured.

Workflow remains **refused**: a manifest-only FunctionNode allow-list cannot prove
routing, and the full route-preserving tree replacement is unmeasured. Static
SequentialAgent/ParallelAgent recipes run with fake receipt replay tests only;
those tests do not replace the host's grants, write confirmations or recovery
store. Dynamic routes, cycles and node retries have no demonstrated replacement.

### Asking for input

See the [ADK request-input guide](../../docs/guides/adk-request-input.md) for a tested Python city-question factory and its validation and restore evidence.

A confirmation beside ordinary tool calls already works: the ordinary bodies run before the
ADK answer, and a denied gated body never runs. Both call orders and two siblings match native
ADK in six live/reloaded Node Worker cases. The same six cases now PASS live and
after real page reloads on local Chromium, Firefox and WebKit; see the
[per-engine record](../../tests/conformance/README.md#adk-engine-measurements).
Real models, devices and browser input/write-retry measurements remain unmeasured.
Writes still need their own host confirmation
and matching checkpoint/recovery stores. The spike's sibling write-retry measurements use a
fake host receipt journal in CPython; they do not add broker integration evidence for this shape.
A confirmation beside a long-running call stays refused because native ADK loses the real answer
when both requests are answered together.

For `adk_request_input`, use an ordinary long-running capability and validate the submitted
answer in the author's `resume`. The host binds `question.ask@1` as a read capability returning
a pending result; the interaction displays the question from the tool arguments. For example,
the measured city-answer shape uses:

```python
from galaxie import GalaxieError
from galaxie.adk import capability_tool

question_tool = capability_tool(
    'ask_city', 'question.ask@1',
    {'type': 'object', 'properties': {
        'message': {'type': 'string'}, 'response_schema': {'type': 'object'},
    }, 'required': ['message', 'response_schema']},
    'Ask for a city.', long_running=True,
)

def interaction(requests):
    return {'surfaceId': 'main', 'viewRevision': 'r1',
            'component': 'app.Question/v1', 'props': {'requests': requests}}

def resume(requests, action, payload):
    if (action != 'submit' or type(payload) is not dict or set(payload) != {'city'}
            or type(payload['city']) is not str or not payload['city']):
        raise GalaxieError('invalid')
    return [{'response': payload} for _ in requests]
```

Add `question_tool` to the leaf's tools and return `Executor(agent, interaction=interaction,
resume=resume)` from the entry factory. This example validates a nonempty city answer; an author
using another response schema must validate that schema instead. The executable evidence is
`python/galaxie/tests/test_adk_beside_calls.py`: the question and schema reach the interaction,
invalid answers leave the pause answerable, and the answer reaches the model live and after
byte restore. The reserved capability name `adk_request_input` is also harmless in that Python
test, but an ordinary name keeps the intent clear. No new helper API ships. Dedicated Chromium,
Firefox, WebKit and real-model input measurements remain unmeasured; see the
[spike record](../../docs/adr/0020-google-adk-through-an-adapter.md#confirmation-beside-calls-and-request-input-spike-2026-11).

### Third-party licenses

The 29-wheel `adk` set carries the licenses its wheels declare in their dist-info metadata:

- Apache-2.0: `google-adk` (declared by classifier), `google-genai`, `google-auth`, `tenacity`, `opentelemetry-api`, `opentelemetry-semantic-conventions` and `requests` (which ships a `NOTICE` file).
- `Apache-2.0 OR BSD-3-Clause`: the vendored `cryptography` 50.0.2 WASM wheel, with `LICENSE`, `LICENSE.APACHE`, `LICENSE.BSD` and the linked dependencies' license texts in its `dist-info/licenses`. It statically links OpenSSL 4.0.3 (Apache-2.0). See the [artifact provenance and verification](../../python/wheels/README.md).
- `Apache-2.0 OR BSD-2-Clause`: `packaging`. `MIT OR Apache-2.0`: `sniffio`.
- BSD-3-Clause: `authlib`, `joserfc`, `websockets`, `starlette`, `httpx`, `idna` and `pycparser`.
- MIT: `fastapi`, `annotated-doc`, `annotated-types`, `anyio`, `cffi`, `charset-normalizer`, `pydantic`, `pydantic-core`, `typing-inspection` and `urllib3`.
- MPL-2.0: `certifi`. PSF-2.0: `typing-extensions`.

Hosts that serve the wheels keep each wheel's `dist-info` license and notice files with it.
