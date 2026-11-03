# @galaxie/adapter-go

The Google ADK (Go) executor adapter (executor id `adk-go`). It runs an agent that the author compiled
to WebAssembly in a dedicated Worker, after checking the module's length and SHA-256, and keeps policy
in JavaScript. See [ADR-0023](../../docs/adr/0023-google-adk-go-through-a-wasm-worker.md) (Proposed)
and the [Go module](../../go/README.md).

## Status

Stage AG1 ships the Worker loader and the gate. `createGoAdapter()` registers `adk-go` with every
feature set to `false`, `prepare` boots and verifies the Worker, and a run fails `unsupported`. The
model bridge, tools, streaming, interactions and durable sessions arrive in later stages, each turning
its feature on with its evidence.

## Hosting

```ts
const adapter = createGoAdapter({
  createWorker: () => new Worker(workerUrl, { type: 'module' }),
});
// agent: the reviewed module, an absolute same-origin URL with its length and SHA-256
await adapter.prepare(
  {
    wasm: { url: 'https://app.example/go/agent.wasm', sha256: '<hex>', bytes: 27_212_737 },
  },
  undefined,
  { signal },
);
```

- Build the module with `GOOS=js GOARCH=wasm CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -buildid="`
  and publish its SHA-256. The Worker fetches same-origin bytes, checks length and digest, and only then
  compiles; any mismatch fails `unavailable` with a fixed message.
- The host's Worker entry imports `wasm_exec.js` first, then `@galaxie/adapter-go/worker`. Fetch the file
  with `scripts/fetch-go-glue.ts`, which checks its digest against `go/wasm.lock`, and let the bundler
  include it; the Worker never loads script text at run time.
- The page CSP needs `'wasm-unsafe-eval'` for the Worker and nothing else beyond the strict baseline.
- The loader replaces `fetch`, `WebSocket`, `EventSource`, `XMLHttpRequest`, `Worker` and `SharedWorker`
  with throwing stubs before the module starts, and discards Go standard output and error. Go code is
  trusted: the stubs catch accidental network use and are not an isolation boundary.
- A Go exit, panic or Worker error marks the Worker dead. The next `prepare` builds a new Worker.
