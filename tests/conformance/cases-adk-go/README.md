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

The matrix in `../compatibility-matrix-adk-go.json` lists every case and the adapter's feature flags.
