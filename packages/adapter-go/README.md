# @galaxie/adapter-go

The Google ADK (Go) executor adapter (executor id `adk-go`). It runs an agent that the author compiled
to WebAssembly in a dedicated Worker, after checking the module's length and SHA-256, and keeps policy
in JavaScript. See [ADR-0023](../../docs/adr/0023-google-adk-go-through-a-wasm-worker.md) (Proposed)
and the [Go module](../../go/README.md).

## Status

`createGoAdapter()` registers `adk-go`: `prepare` boots and verifies the Worker, and a start command runs
the entry the agent names, with model calls routed through the host and capability calls through the
broker. `streaming`, `interrupts` and `resume` are on. Durable sessions arrive in a later stage and turn
`checkpoints` on with their evidence; `subgraphs` stays off.

## Streaming

Set `stream: true` on the agent (`{ wasm, entry, stream: true }`) to receive stream events for a run.
Each model reply is read from the provider as it grows. Every growing reply, including call arguments,
passes the output-safety hook before its text leaves as a `messages` event `{ author, text }`, split at
4096 characters and never inside a surrogate pair; the finished reply passes the hook once more. A block
fails the call `denied`: the blocked text is never forwarded, and deltas already delivered are not
retracted. Tool turns emit content-free `updates` markers `{ step, tool, index }` with the offered name
and a run-wide position, never a call ID, argument or result. An abort stops further events.

Go still receives one aggregated reply per model call, so ADK runs in its server-sent-events mode but
sees no partial response: the page checks and forwards the text, and nothing unchecked reaches Go. Without
`stream`, a run emits only its output. Stream events are delivered live and are not journaled.

## Interactions

A tool created with `RequireConfirmation` (the tool does not run before approval) or `LongRunning` (the
tool returns its pending result, and the real result arrives with the answer) ends the run with one
interaction. The Go author supplies a `galaxie.Definition`: `Interaction` builds the four-field request
(`surfaceId`, `viewRevision`, `component`, `props`) from the paused calls, which reach the hook by
position and never carry an ADK call ID; `Resume` maps the user's action and payload to one decision per
call. Without `Resume`, the default accepts `approve` or `deny` with `{ indexes }` naming every request
exactly once and fails `invalid` otherwise. The page checks the request with core's four-field parser
before it reaches the host, `pending()` returns it while the pause lasts, and the answer comes back as a
new run that continues the paused session in the same Worker.

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
  `Interaction` hook is refused before it runs.
- The paused session lives in the Worker's memory. If the Worker dies, the pause is gone and the session
  is unrecoverable; nothing is persisted until durable sessions ship.
- Effect scopes continue across the runs of one conversation, so a resumed run never reuses the scope of
  an earlier call.

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
- The host's Worker entry imports `wasm_exec.js` first, then `@galaxie/adapter-go/worker`. Fetch the file
  with `scripts/fetch-go-glue.ts`, which checks the copied source file against the digest in
  `go/wasm.lock`, and let the bundler include it; the Worker never loads script text at run time. The
  digest covers that source file only: a bundler may minify or re-wrap it, so the shipped bytes are
  not hash-checked. Hosts that need that should pin the built output themselves.
- The page CSP needs `'wasm-unsafe-eval'` for the Worker and nothing else beyond the strict baseline.
- The loader replaces `fetch`, `WebSocket`, `EventSource`, `XMLHttpRequest`, `Worker` and `SharedWorker`
  with throwing stubs before the module starts, and discards Go standard output and error. Go code is
  trusted: the stubs catch accidental network use and are not an isolation boundary.
- A Go exit, panic or Worker error marks the Worker dead. The next `prepare` builds a new Worker.
