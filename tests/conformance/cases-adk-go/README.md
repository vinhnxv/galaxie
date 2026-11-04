# ADK Go conformance cases

`scripts.json` lists each case: the entry to run, the prompt, the scripted model replies and the scripted
capability outcomes. The Go side of every entry lives in `go/conformance/cases`.

- **Native lane.** `go test ./conformance/` in `go/` runs each entry with Google's own runner against a
  scripted page and compares the recorded wire transcript with `../golden-adk-go/<case>.json`.
  `GALAXIE_RECORD_ADK_GO=1 go test -count=1 ./conformance/` re-records the goldens.
- **Node lane.** `../adk-go.node.test.ts` builds the reference module (`go/conformance/reference`), boots
  it in a Node Worker behind the real adapter with a scripted chat model, and expects the same transcript.
- **Chromium lane.** `examples/rag-browser/test/adk-go-reference.node.test.ts` does the same in headless
  Chromium under the strict mock-mode CSP, and checks that the module cannot compile without
  `'wasm-unsafe-eval'`.

A case with `stream: true` runs with stream events on. The native lane has no page, so its golden still
records only the wire transcript (with each reply's `chunks` removed, since Go receives the aggregated
reply); the Node and Chromium lanes also compare the page's stream events with the case's `streams`.

A case with `answers` pauses: each entry (`action`, `payload`) answers the next interaction the run
raises. The native golden then also records `pauses`, the interaction requests the author built, and the
Node and Chromium lanes compare the requests the host receives (without interaction IDs).

A case with `unordered: true` runs sibling branches at once, so their requests, replies and capability
calls reach the page in any order. The native recorder and the TypeScript runner both sort those three
lists by the canonical JSON text of each entry before comparing; keep such a case's branches identical
in shape so the sorted transcript is stable, and keep their text ASCII: Go and JavaScript order
non-ASCII strings differently and escape some code points differently.

The matrix in `../compatibility-matrix-adk-go.json` lists every case and the adapter's feature flags.

`../adk-go-run.node.test.ts` runs the same module for behavior the native lane cannot express: a raising
model, the step budget, a blocked argument, abort, a panic (contained and reported as a fixed
`executor_error`), `os.Exit` (the Worker dies, the run fails `unavailable`) and a loop that ignores its
context (the Worker is terminated and the session is unrecoverable). `../adk-go-scan.node.test.ts` scans
the bridge traffic, events, snapshots and spans for a per-call provider credential.
