# @galaxie-ai/adapter-go

> This package is experimental and is not published to a package registry. Its API can change in any commit without notice.

The Google ADK (Go) executor adapter (executor id `adk-go`). It runs an agent that the author compiled
to WebAssembly in a dedicated Worker, after checking the module's length and SHA-256, and keeps policy
in JavaScript. See [ADR-0023](../../docs/adr/0023-google-adk-go-through-a-wasm-worker.md) (Proposed)
and the [Go module](../../go/README.md).

## Status

`createGoAdapter()` registers `adk-go`: `prepare` boots and verifies the Worker, and a start command runs
the entry the agent names, with model calls routed through the host and capability calls through the
broker. `streaming`, `interrupts`, `resume` and `checkpoints` are on; `subgraphs` stays off. Durable
sessions need `services.checkpoints` (see "Durable sessions"); without it a paused session lives in
the Worker only.

## Streaming

Set `stream: true` on the agent (`{ wasm, entry, stream: true }`) to receive stream events for a run.
Each model reply is read from the provider as it grows. Every growing reply, including call arguments,
passes the output-safety hook before its text leaves as a `messages` event `{ author, text }`, split at
4096 characters and never inside a surrogate pair; the finished reply passes the hook once more. A block
fails the call `denied`: the blocked text is never forwarded, and deltas already delivered are not
retracted. Tool turns emit content-free `updates` markers `{ step, tool, index }` with the offered name
and a run-wide position, never a call ID, argument or result. An abort stops further events.
The stream queue holds at most 256 events and applies backpressure.

Go still receives one aggregated reply per model call, so ADK runs in its server-sent-events mode but
sees no partial response: the page checks and forwards the text, and nothing unchecked reaches Go. Without
`stream`, a run emits only its output. Stream events are delivered live and are not journaled.

The [stream namespace spike](../../docs/adr/0020-google-adk-through-an-adapter.md#stream-namespaces-workflow-agents-and-subgraphs-spike-2026-11)
records **refused** for the full ancestry oracle: pinned ADK's Runner rejects
globally duplicate names, contrary to the registered six-tree premise. A partial
native-Go recipe maps existing bridge authors through an author-owned lookup for
Sequential, Parallel, nested, Loop and transfer trees, but establishes no new
nested-path browser support. The bridge carries no tree/path field. Stream paths
remain empty, scopes positional, PendingInteraction has no path and no namespace
is stored; `subgraphs` stays false. Workflow is **refused** by source fact: ADK
v1.9.0 has no workflow graph package or exported Workflow type. The older
SequentialAgent, ParallelAgent and LoopAgent remain supported. The
[duplicate-identity outcome](../../docs/adr/0020-google-adk-through-an-adapter.md#duplicate-identity-measured-outcome-2026-11-13)
confirms that a repeated name fails `unsupported` at Execute before model dispatch.
Rename agents for a fresh tree; no Go behavior, stored format or flag changed.

## Interactions

See the [ADK request-input guide](../../docs/guides/adk-request-input.md#go-and-evidence-limits) for the pinned Go source fact and the limits of the input measurements.

A tool created with `RequireConfirmation` (the tool does not run before approval) or `LongRunning` (the
tool returns its pending result, and the real result arrives with the answer) ends the run with one
interaction. The Go author supplies a `galaxie.Definition`: `Interaction` builds the four-field request
(`surfaceId`, `viewRevision`, `component`, `props`) from the paused calls, which reach the hook by
position and never carry an ADK call ID; `Resume` maps the user's action and payload to one decision per
call. Without `Resume`, the default accepts `approve` or `deny` with `{ indexes }` naming every request
exactly once and fails `invalid` otherwise. The page checks the request with core's four-field parser
before it reaches the host, `pending()` returns it while the pause lasts, and the answer comes back as a
new run that continues the paused session: in the same Worker without a store, or from the stored
record with one.

- A pause is consumed by its answer whether or not the answer is valid; an answer for another
  interaction fails `stale` and leaves the pause. A new prompt drops the pause it replaces.
- Two confirmations in one model response form one interaction. A confirmation next to a plain call runs
  the plain call once and holds the other. The order in which concurrent sibling calls reach the broker
  is not stable.
- ADK resumes only the agent that paused, so a pause is accepted where nothing after it is lost: the
  agent and every ancestor are `LlmAgent`s, or the agent is the last child of each `SequentialAgent`
  above it. A pause inside a `ParallelAgent`, a `LoopAgent` or an earlier child of a sequence fails
  `unsupported` (recorded against ADK Go v1.9.0 in `go/galaxie/trees_test.go`), as does a confirmation
  next to a long-running call in the same turn, and a module whose tools can pause without an
  `Interaction` hook is refused before it runs. The check for long-running tools happens before the run,
  because such a tool executes before it pauses. A capability whose tool name equals ADK's confirmation call
  name (`adk_request_confirmation`) is refused.
- Without `services.checkpoints` the paused session lives in the Worker's memory. If the Worker dies,
  the pause is gone and the session is unrecoverable.
- Effect scopes continue across the runs of one conversation, so a resumed run never reuses the scope of
  an earlier call.

## Durable sessions

Pass the byte-record port of `@galaxie-ai/storage-indexeddb` as `services.checkpoints` (for example
`saver.byteRecords`) and a pause or a finished conversation survives a reload, a lost Worker and a
cancelled or failed resume.

ADK Go v1.9.0's in-memory session service has no codec: it stores `*session.Event` values and state
in process memory and offers no export. The program therefore keeps no session between runs. With
`persist`, each run ends by returning the whole conversation as a closed-shape JSON record (the event
log, the counters the run needs, the effect-scope memory and the pause with its verified calls). The
page stores it and sends it back as `restore`; the program rebuilds the ADK session with `Create` and
`AppendEvent` replay, resumes from it, and returns the next record. Every record and every restored
pause is decoded with unknown keys, event identifiers and sizes checked, and a resume checks that each
paused call matches the stored events and the request derived from them, and that the interaction ID
matches the digest of the conversation, ordinal and request.

- One checkpoint per revision holds the record; the key, the stream position and an HMAC-SHA-256 tag
  over session, revision, position and record sit in its metadata. The marker (`__interrupt__`) is written first
  and the checkpoint commits it, so a crash between the two leaves the previous revision current. The
  tag detects corruption, truncation, splicing between sessions and accidental or blind misplacement
  of a record between revision slots. The key lives beside the record, so anyone who can read and
  write the store can recompute the tag. Restoring an earlier valid revision after newer ones were
  removed is not detected. The format is not published, so no migration was needed; an earlier
  development record restores as `unrecoverable`.
- The page keeps memory and store equal: a pause is published only after its record is stored, and a
  run that fails, is cancelled or is refused leaves the stored pause answerable. A Worker that dies
  after Go finished, but before the page recorded the result, still publishes and stores the pause.
- Restored text is registered with core before the program sees it, again for every run that replays
  it. A host whose core does not provide that hook gets `unsupported` rather than exposed text.
- Effect scopes, conversation IDs and ordinals come from the record, so a restored run never reuses a
  scope. Interaction IDs depend on the conversation, ordinal and request, not on the Worker.
- A record is capped at 512 KiB, below the 1 MiB bridge frame. A run that would outgrow it fails
  `unsupported` before the next model or tool call, and the previous revision stays current. The
  guard counts stored events only, so a pause with very large call arguments, or a resume whose
  answer pushes the events past the limit, can still fail late; the previous revision then stays
  current and the pause stays answerable.
- A resume that fails after an approved write ran offers the same pause again. Pair
  `services.checkpoints` with core's `recovery` store whenever the agent binds a write capability:
  without it the write can run a second time when the pause is answered again.
- A failed storage call keeps its reason (`fenced`, `stale`, `unrecoverable`); any other failure is
  `unavailable`.
- Whoever can write the store can change the history the model sees; the tag is corruption detection,
  not protection against a hostile page. Keep the store on-device under the checkpointer's app and
  principal scope, with one active owner per session.

## Authoring surface

Agent code imports `galaxie.invalid/galaxie/galaxie` and builds its tree only with these constructors; a
program registers entries with `galaxie.Serve` (or `ServeWith` for entries that pause) and blocks.

| Constructor | Purpose |
| --- | --- |
| `Model(role)` | The model of an `LlmAgent`: every request goes to the page's router for that role. |
| `LlmAgent`, `SequentialAgent`, `ParallelAgent`, `LoopAgent(config, maxIterations)` | ADK's agents, wrapped so the tree can be checked. `LlmAgent` sub-agents give ADK's transfer. |
| `CapabilityTool(name, spec)` | A function tool that calls a host capability through the broker. `spec` sets the description, the JSON schema and `RequireConfirmation` or `LongRunning`. |
| `Toolset(tools...)` | A fixed, ordered grouping of capability tools created during this build; returns the toolset and an error. |
| `ExitLoop()` | The tool that ends a `LoopAgent`; a loop needs it or a non-zero iteration limit. |
| `Definition{Build, Interaction, Resume}` | Pairs an entry with the hooks that turn paused calls into a request and an answer into decisions. |

These shapes run: a single `LlmAgent` with capability tools, `SequentialAgent`, `ParallelAgent` and
`LoopAgent` trees up to 16 levels deep, transfer to a sub-agent, and a confirmation or long-running tool
where the pause rule accepts it ("Interactions"). Branches of a `ParallelAgent` get branch-local effect
scopes, so the order in which they reach the broker does not change what a write receives, and a restore after a later pause does not run them again;
the order of their events does vary. These shapes fail `unsupported` before anything runs: `agenttool`,
an agent, model, function tool or toolset built directly with ADK, and a tree outside the limits above.
`subgraphs` stays false. Every shape is recorded with its native result in `tests/conformance` and
`go/galaxie/shapes_test.go`; see the [limits](../../docs/unsupported.md#google-adk-go).

### Porting models and static toolsets

See the [ADK models-and-tools guide](../../docs/guides/adk-models-and-tools.md) for native-tested explicit-model and fixed-toolset examples across executors.

The [host inventory outcome](../../docs/adr/0020-google-adk-through-an-adapter.md#host-role-inventories-for-model-strings-and-fixed-toolsets-2026-11)
adds fixed capability toolsets. Native Go has no
string-model form. Replace a foreign `model.LLM` with `galaxie.Model("answer")`;
the host declares and routes `answer`. A foreign model or native toolset still
fails `unsupported` before requests. Create fresh values inside `Definition.Build`.

```go
func build() (agent.Agent, error) {
    specs := []struct { name string; spec galaxie.ToolSpec }{
        {"docs.search@1", galaxie.ToolSpec{Description: "Search documents.", Schema: `{"type":"object","properties":{"q":{"type":"string"}},"required":["q"]}`}},
    }
    tools := make([]tool.Tool, 0, len(specs))
    for _, item := range specs {
        created, err := galaxie.CapabilityTool(item.name, item.spec)
        if err != nil { return nil, err }
        tools = append(tools, created)
    }
    group, err := galaxie.Toolset(tools...)
    if err != nil { return nil, err }
    return galaxie.LlmAgent(llmagent.Config{Name: "root", Model: galaxie.Model("answer"), Toolsets: []tool.Toolset{group}})
}
```

`galaxie.Toolset` accepts a non-empty list of capability tools from the current
build, copies it and returns fresh slices. `LlmAgent` appends toolset members after
flat tools, in toolset order, then clears native `Toolsets` before constructing the
agent. Empty, nested, foreign, control-tool and duplicate-name groups refuse
`unsupported`; names must also be distinct from flat tools and other groups.
Grouped tools obey the existing pause and replay rules. Native ADK toolsets,
dynamic lists and network toolsets stay refused.

This uses the existing `agent`, `llmagent`, `tool` and `galaxie` imports. MCP-backed
entries use the host's `tools-mcp` capability bindings. Dynamic lists and network
toolsets have no proven replacement. Built-in network/code tools remain **REFUSED**:
`RequestToWire` rejects provider tool configuration. The pinned agent config has
no planner or code-executor field. Host-bound network reads are general guidance,
not a same-script replacement for provider-native tools. Scripted native Go and
Node Worker tests cover fixed-toolset declaration order, confirmation, reload and
effect identity. Firefox, WebKit, real models and devices remain unmeasured for
these shapes.

## Build and licenses

```sh
GOOS=js GOARCH=wasm CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -buildid=" -o agent.wasm ./your/agent
```

`node scripts/build-go-wasm.ts ./your/agent` runs the same command with the flags locked in
`go/wasm.lock` and prints the size and SHA-256 to publish; the package path is relative to the `go/`
module and the script requires the locked toolchain, Go 1.27.3. The module is about 30 MB stripped,
about 6.5 MB gzip. TinyGo and `wasm-opt` are not used.

The module links third-party code under permissive licenses, listed per module in `go/wasm.lock`.
Google's ADK (`google.golang.org/adk`), genai, gRPC, OpenTelemetry and most other Google modules are
Apache-2.0; `golang.org/x/*`, `google.golang.org/protobuf` and Go's own `wasm_exec.js` are BSD-3-Clause;
the lock also holds MIT and BSD-2-Clause modules. The Go standard library and runtime linked into the
module are BSD-3-Clause and are not in the lock, which lists modules only. Hosts that ship the module
must carry those notices with it.

## Hosting

```ts
const adapter = createGoAdapter({
  createWorker: () => new Worker(workerUrl, { type: 'module' }),
});
// agent: the reviewed module, an absolute same-origin URL with its length and SHA-256
await adapter.prepare(
  {
    wasm: { url: 'https://app.example/go/agent.wasm', sha256: '<hex>', bytes: 29_960_388 },
  },
  undefined,
  { signal },
);
```

- Build the module with `GOOS=js GOARCH=wasm CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -buildid="`
  and publish its SHA-256. The Worker fetches same-origin bytes, checks length and digest, and only then
  compiles; any mismatch fails `unavailable` with a fixed message.
- The host's Worker entry imports `wasm_exec.js` first, then `@galaxie-ai/adapter-go/worker`. Fetch the file
  with `scripts/fetch-go-glue.ts`, which checks the copied source file against the digest in
  `go/wasm.lock`, and let the bundler include it; the Worker never loads script text at run time. The
  digest covers that source file only: a bundler may minify or re-wrap it, so the shipped bytes are
  not hash-checked. Hosts that need that should pin the built output themselves.
- The page CSP needs `'wasm-unsafe-eval'` for the Worker and nothing else beyond the strict baseline.
- The loader replaces `fetch`, `WebSocket`, `EventSource`, `XMLHttpRequest`, `Worker` and `SharedWorker`
  with throwing stubs before the module starts, and discards Go standard output and error. Go code is
  trusted: the stubs catch accidental network use and are not an isolation boundary.
- A Go exit, panic or Worker error marks the Worker dead. The next `prepare` builds a new Worker.
