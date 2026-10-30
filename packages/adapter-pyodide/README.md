# @galaxie/adapter-pyodide

An experimental executor adapter for trusted LangGraph Python graphs running in a
dedicated Pyodide 314.0.7 module Worker. The graph uses the Python `galaxie` proxies;
the existing JavaScript router and broker own routing, consent, labels, budgets,
credentials, output checks and capability authorization.

The host supplies `createPyodideAdapter({ createWorker, runtimeUrl, wheelsUrl,
localWheels, onBoot? })`. `createWorker` returns a port with `postMessage(string)`,
message and error listeners, and `terminate()`. A browser `Worker` satisfies that
shape. Node hosts wrap `worker_threads.Worker`. Constructing the adapter fetches
nothing and starts no Worker; `prepare` loads the source files and boots the interpreter.

The agent descriptor is `{ baseUrl, files, module, entry }`. Source paths are relative
Python or JSON files, the module is a dotted Python import name, and the entry is a
zero-argument function returning the graph. Sources and wheels are same-origin in
the browser and fetched with credentials omitted. On Node, the runtime directory may
be local because native ESM cannot import an HTTP module; agent files and wheels may
still be served from loopback. The host serves runtime assets together and supplies
the two locally built wheel records, including their byte sizes and SHA-256 hashes.

Services are `{ chatModels, checkpoints? }`; `chatModels` is keyed by provider ID. Each entry is a LangChain
`BaseChatModel`, or a function receiving `{ credential }` and returning a model when
the provider descriptor requires per-call credentials. Implementations are checked
against core's preparation requirements. Credentials remain in JavaScript.

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

`interrupts`, `resume`, `checkpoints`, `streaming` and `subgraphs` are true. For durable sessions, supply
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
application still renders only its final result, and default sessions remain in
memory; no review UI or persistent RAG session flow is added.

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

The maintained RAG transcript matches across native CPython 3.14, Pyodide on Node
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

`linear` and `branching` also match the native Python stream events, mode order and
paths on Node Pyodide and real Chromium. Both lanes prove checked deltas and final
usage, cancellation after a checked delta, early public stream close followed by
terminal model settlement and another run, a mid-stream block with only the allowed prefix observed in Python, fixed
failures for non-JSON/oversized chunks, and stream-free event replay. Chromium keeps
the existing CSP and Trusted Types policy and blocks external requests.
