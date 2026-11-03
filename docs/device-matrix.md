# Tested device matrix

This records automated coverage and the existing real-device demonstrations.
It makes no browser-support or performance promise. The verdict is framework
parity; model quality and timings are demonstrations
([ADR-0016](adr/0016-parity-demonstrations-and-otel-traces.md)). No additional
real model or device was exercised for this documentation slice.

## Automated lanes

Configuration checked on 2026-10-30: [CI workflow](../.github/workflows/ci.yml),
[Node version](../.nvmrc), [pinned Playwright](../package.json), and
[Vitest projects](../vitest.config.ts). CI runs on `ubuntu-24.04`.

| Environment | What runs | Model/device substitution | Evidence |
| --- | --- | --- | --- |
| Node 24 | Unit and conformance tests, native LangGraph baseline, loopback HTTP/MCP and Node-driven browser loops | Scripted mock providers, fake WebGPU/engine resources, fake `LanguageModel`, injected fetch | [Conformance suite](../tests/conformance/README.md), `CI=true pnpm test`, configured 2026-10-30 |
| Headless Chromium installed by Playwright 1.64.1 | Vitest browser project: parity, real DOM/IndexedDB/Web Locks/CSP paths and recovery/ownership controls; separate host loops also drive headless Chromium | Mock providers and fake model APIs; no real GPU inference or browser-managed model invocation | [Vitest configuration](../vitest.config.ts), [M3 automated evidence](m3-exit-record.md#acceptance-tests), configured 2026-10-30 |
| CPython 3.14, uv-locked environment | Offline Python proxy, stand-in and RAG graph tests; native transcript reference | Real interpreter and LangGraph; fake bridge, deterministic model/retrieval replies | [Python test runner](../scripts/test-python.ts), `pnpm test:python`, configured 2026-10-30 |
| Pyodide 314.0.7 on Node 24 and headless Chromium | Real dedicated Workers, hash-verified wheel installation, LangGraph graph execution and bridge lifecycle; Chromium boot also checks strict CSP/Trusted Types on every response | Real WASM interpreter and locked frameworks; deterministic JavaScript models and retrieval | [Python adapter](../packages/adapter-pyodide/README.md), [RAG example](../examples/rag-browser/README.md), configured 2026-10-30 |

Playwright's Chromium is not the maintainer's Chrome 155. These lanes download
no model weights, execute no real WebLLM engine and call no real `LanguageModel`
global. Host-loop tests verify that the real WebLLM bundle is not requested.
The [injection corpus](../tests/injection-corpus/README.md) uses the deterministic
obedient-attacker mock, not a robustness evaluation of a real model.

The [browser-built RAG example](../examples/rag-browser/README.md) adds Node and headless Chromium lanes with a synthetic corpus, deterministic embeddings/chat and a fake Transformers engine. They cover retrieval, citations, injected directives, real module Workers, IndexedDB restore and clear fencing, strict CSP, keyboard controls and phone-width layout. The optional Python host loop adds lazy interpreter startup, executor switching, boot cancellation/failure and disposal. All five JavaScript/Pyodide/CPython transcript lanes match the shared golden. Real Pyodide execution does not imply real inference. [Local headless startup and response-body observations](../examples/rag-browser/README.md#local-python-observations) are demonstrations, separate from GitHub CI execution and the reference-device rows below. Full SQuAD indexing, real EmbeddingGemma/WebGPU, citation quality and reference-device metrics remain unmeasured.

## Real-device demonstrations

| Device and browser | Date and record | What was real | Limits |
| --- | --- | --- | --- |
| Apple M5 Pro, macOS, Chrome 155; WebGPU adapter `apple metal-3` | 2026-10-29, [M2 exit record](m2-exit-record.md) and [raw figures](../examples/host-local/results/2026-10-29-apple-m5-pro-chrome-155.json) | Two full local tutor lessons: one with Built-in AI available (route inferred from ordering), one with `LanguageModel` removed so WebLLM ran on WebGPU; schema-valid structured calls with no repair | AT-03 demonstrated on this device. AT-04 capture covers page requests after weights were cached; dedicated-worker requests and browser-owned Built-in AI traffic were outside the capture. |
| Apple M5 Pro, macOS, Chrome 155.0.8059.86 | 2026-10-29, [M3 exit record](m3-exit-record.md) | Real-model host-local with IndexedDB: same-quiz reload restore, writing-prompt restore, duplicate submits, one saved progress effect, cooperative two-tab handover, sign-out from the former owner | The real post-submit reload missed the accept-to-consume crash window. Forced takeover and real back/forward-cache restoration were not demonstrated. |

The M2 timings are one run per route with cached WebLLM weights, not latency
distributions. The M3 observations do not establish renderer-crash recovery.
Exit records are historical: their “not yet built” sections describe their
recorded slice, rather than overriding the current
[implemented contract](system-design.md#1-what-exists-today).

## Untested or unmeasured

- Other browsers, Firefox, Safari, mobile devices, other GPUs and other operating
  system/device combinations have no real-device evidence in these records.
- M2 did not measure first-download size/time, time to first token, p50/p95,
  main-thread long tasks or memory. Worker network capture and browser-owned
  download traffic remain gaps in the real local-only demonstration.
- The ONNX provider has no real-device row: no pinned model, no WebGPU or WASM run, no download size or time, no memory, no time to first token and no prefill abort latency. Its tests use a fake runtime on Node and headless Chromium, and a strict-CSP probe page that runs a one-node ONNX graph on the WASM execution provider ([ADR-0021](adr/0021-in-browser-onnx-chat-provider.md)).
- WebLLM prefill abort latency, page/worker adapter agreement and the cost of
  resetting instead of reusing KV cache remain unmeasured. Built-in AI session
  creation cost and stable/beta smoke coverage remain open
  ([provider limits](system-design.md#84-a-model-call)).
- M3 did not measure a browser/renderer crash, the real-model accept-to-consume
  window, forced real-model takeover, real bfcache restore, restore latency or
  storage size after a lesson. Fault-injection and synthetic-event coverage is
  automated evidence only. The external developer trial remains open.
- Real remote-provider, user-endpoint/LNA and MCP deployments are not established
  by these exit records or the mock/injected/loopback CI tests. This slice also
  records no live tracing-exporter or Langfuse connection.

Use `pnpm check` for the full local gates and `CI=true pnpm test` for Node and
headless Chromium tests without updating missing goldens. The
[host integration guide](guides/host-integration.md) explains the host's work;
this matrix does not replace that work.
