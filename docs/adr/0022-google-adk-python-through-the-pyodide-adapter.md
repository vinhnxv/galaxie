# ADR-0022: Google ADK (Python) through the Pyodide adapter, with an explicit wheel list

- **Status:** Proposed
- **Date:** 2026-11-03
- **Related:** brief §6.2, §7.4; ADR-0002, ADR-0012, ADR-0017, ADR-0018, ADR-0020
- **Revisions:** 2026-11-03: created with stage AP1 (pin, closure, lock strategy, first-run gate); stage AP2 adds the model, tool and run evidence (features stay false); stage AP3 adds streaming and turns `streaming` on; the remaining per-stage evidence arrives with stages AP4 to AP6.

## Context

Agent authors ask for Google's Agent Development Kit in Python. ADR-0018 gives Python a boundary: a dedicated Pyodide Worker, proxies only in the `galaxie` Python package, and policy kept in JavaScript. ADR-0020 covers the JavaScript ADK adapter. Its Python sibling needs the same executor shape as pydantic-ai and DSPy, but the engine is heavier and has hazards of its own. A feasibility run on 2026-11-03 put `google-adk` 2.12.0 in Pyodide 314.0.7 on Node and found four:

- The first `Runner.run_async` imports `fastapi`, `authlib` (and so `cryptography`) and `opentelemetry` lazily. An import-only probe passes while the first run fails.
- ADK's metadata would move three existing pins: `opentelemetry-api`, `tenacity` and `websockets`, and `opentelemetry-sdk` places an exact pin on `opentelemetry-semantic-conventions`.
- A string model name resolves through ADK's registry to `Gemini` and the Google client, a route around galaxie.
- Nothing had run in Chromium under the strict CSP or through the galaxie bridge.

## Decision

1. **A fourth framework option, not a new package.** `createPyodideAdapter({ framework: 'adk' })` gives executor id `adk-python`, beside `langgraph-python`, `pydantic-ai-python` and `dspy-python`. Core keys executors by id and needs no change. Registration is a `PythonFramework` member, the id string, the wheel tag `adk`, a driver module, a boot import probe and, from stage AP2, a `galaxie.adk` Python module.
2. **Pin `google-adk` 2.12.0.** It is the newest release at or before the fixed Python lock cutoff `2026-10-23T17:00:00Z` (uploaded 2026-10-13, Apache-2.0, `requires-python >=3.11`). Its 2.x line is unrelated to the JavaScript package's 2.3.0. 2.13.0 (uploaded 86 minutes after the cutoff) waits for the next cutoff. A bump re-runs the hidden-import discovery, the symbol-presence test and the conformance lane.
3. **Overrides keep every existing pin; the Worker gets an explicit wheel list.** `python/galaxie/pyproject.toml` gains an `adk` extra, `["google-adk==2.12.0"]`. `python/pyproject.toml` gains `override-dependencies` (`opentelemetry-api==1.45.1`, `opentelemetry-semantic-conventions==0.66b1`, `tenacity==9.2.1`, `websockets==17.3`) and extra constraints (`cryptography==47.0.0`, `cffi==2.0.0`, `pycparser==3.0`), so `uv lock` adds 22 packages and moves none. `requirements.lock` gains ten wheels tagged `adk` and the `adk` tag on 19 shared wheels. The `adk` set is 29 wheels and 12,622,878 bytes; the three existing sets and their fingerprints are unchanged. Hashes come from PyPI and the Pyodide lock and are checked by `fetchWheel`. The Worker installs with `depends: []`; `micropip.install` is never used for ADK. `watchdog`, `uvicorn`, `grpcio`, `aiosqlite`, `graphviz`, `click`, `python-dotenv`, `python-multipart`, `opentelemetry-sdk`, `pyasn1*`, `mcp` and `google-cloud-*` stay out of `requirements.lock`; the tests assert it. A lock test also asserts that each distribution shared by the two locks has one version.
4. **The gate proves the first run, not the import.** The gate is a scripted `Runner.run_async` (text, tools, confirmation, long-running tools, SSE streaming, sequential, parallel and loop agents, structured output, transfer, failures, cancellation, event-replay restore and the integrity plugin) on CPython, on Pyodide in Node, and on Pyodide in headless Chromium under the unchanged strict CSP and Trusted Types with `fetch`, `WebSocket` and `XMLHttpRequest` replaced by throwing stubs. It also asserts that no thread starts during the run (a spy on `threading.Thread.start`; on Pyodide threads cannot start at all, so the assertion is meaningful on CPython) and that the modules kept out of the Worker (`uvicorn`, `watchdog`, `grpc`, `aiosqlite`, `mcp`, `opentelemetry.sdk`) are absent. The Worker boot imports the hidden modules (`fastapi.openapi.models`, `authlib.integrations.requests_client`, `opentelemetry._logs`, `opentelemetry.semconv`) so that a missing wheel fails at boot with the fixed `unavailable` error, not at the first run. Every bump repeats the discovery by removing each candidate from a working environment.
5. **Fail-closed tree validation by registry membership** (applies from stage AP2). Host helpers record every model and tool they create in a module-private registry. At prepare the driver accepts exact classes `LlmAgent`, `SequentialAgent`, `ParallelAgent` and `LoopAgent`, only registry models and tools (resolving inherited and omitted models the way ADK does), and refuses `Workflow`, `AgentTool`, toolsets, code executors, planners, plugins, `App`, string model names and `Gemini` with fixed `unsupported` errors. Authors never see the Runner.
6. **The adapter owns the Runner and every service** (stage AP2). It builds the `App` with one plugin, ADK's `ToolCallIntegrityPlugin`, a galaxie session service and a `RunConfig`, and drives only `run_async`. Fatal errors propagate out of `run_async` in 2.12.0; a per-run failure slot covers author callbacks that swallow them. `limits.steps` is enforced once, in the model's call count.
7. **Pauses end the run; resume is a new `run_async`** (stage AP4), as in ADR-0020. Sessions persist as an event log through the existing byte-record port with a per-session integrity key kept in record metadata (stage AP5); the record must fit the 1 MiB bridge frame.
8. **Executor features turn on only with their evidence.** The adapter first registered `adk-python` with `streaming`, `interrupts`, `resume`, `checkpoints` and `subgraphs` all false. Stage AP2 runs text and tool-calling agents end to end with those flags still false; stage AP3 turns `streaming` on. Each flag turns on only with the evidence listed under Verification. `subgraphs` stays false for the reasons ADR-0020 and ADR-0018 give.
9. **Python is trusted.** A Worker can `import js`; the tree validation and the lint aid reduce accidents and are not an isolation boundary (ADR-0018). Only third-party wheels have independent hash checks. No CSP, Trusted Types or ADR-0012 guarantee changes.
10. **Streaming projects ADK's SSE events onto the existing stream modes** (stage AP3). A run always asks ADK for SSE, so every model call is a streamed bridge request and the routed provider must declare `streaming`. The runtime checks each growing chunk and the final reply before Python receives them; the router-backed model turns the checked chunks into partial responses and the final reply into the complete response. `messages` events carry `{ author, text }` deltas of at most 4096 code points: a surrogate pair split across two provider chunks is joined first and never split, and thought parts and tool-call fragments are excluded. `updates` events carry only `{ step, tool, index }` markers (the offered tool's name and a run-wide position), never a call ID, an argument or a result. A mid-stream block fails `denied` without forwarding the blocked delta; earlier deltas are not retracted. The stream is not journaled.

## Alternatives considered

- **A new package for ADK Python.** Rejected: it needs the same Worker, bridge, wheel verification and checkpoint op as the adapter, so it would duplicate them.
- **`micropip` with a resolver.** Rejected: the Worker restores the real `fetch` after install, a resolver makes the closure unpinned, and ADR-0018 decision 10 requires exact hash-pinned wheels.
- **Metadata-only stand-ins for `authlib` and `fastapi.openapi.models`.** Not built: they would drop about 2.5 MB, but untested stand-ins raise drift risk against ADK. A measured Worker boot cost on a real device would reopen the call.
- **A separate uv project for the ADK lane.** The fallback if the overrides are judged too invasive; the Worker set would be the same.
- **Stand-ins for `watchdog` and `uvicorn`.** Not built: no resolver runs in the Worker, and the CPython reference environment installs them normally.

## Consequences

- The Worker download for an ADK agent is the 29-wheel set (about 12.6 MB, of which about 9.4 MB is new). The rag-browser build now emits those wheels because its asset plugin emits every locked wheel.
- Licenses of the ten new wheels, from their dist-info metadata: `google-adk` Apache-2.0; `google-genai` Apache-2.0; `google-auth` Apache-2.0; `opentelemetry-semantic-conventions` Apache-2.0; `cryptography` Apache-2.0 OR BSD-3-Clause; `authlib` BSD-3-Clause; `joserfc` BSD-3-Clause; `starlette` BSD-3-Clause; `fastapi` MIT; `annotated-doc` MIT.
- `google.genai` imports `ssl`; the gate runs on Pyodide in Node and Chromium, so the import resolves there. A local CPython needs an OpenSSL-linked build.
- `opentelemetry-sdk` is absent from the Worker, so ADK spans are no-ops through the API. Galaxie's own allowlisted spans cover runs. The CPython reference environment still installs `opentelemetry-sdk` 1.42.1, whose exact pins disagree with the forced `opentelemetry-api` and semantic-conventions overrides, so the CPython gate runs a forced combination that the Worker does not have.
- ADK's `Sequential`, `Parallel` and `Loop` agents emit `DeprecationWarning` in 2.12.0 and work. The confirmation feature is flagged experimental in 2.12.0.

## Verification

Observed in stage AP1 (scripted models only, no real model download):

- CPython: the offline scripted gate passes against a lock-synced environment (`python/galaxie/tests/test_adk_gate.py`).
- Pyodide on Node: the same gate passes with the 29 wheels installed through `loadPackage` with integrity checks, no network fetch and no thread (`packages/adapter-pyodide/test/adk-gate.node.test.ts`).
- Headless Chromium: the same gate passes under the unchanged strict CSP and Trusted Types with no violation, no external request and no network attempt (`examples/rag-browser/test/adk-gate.node.test.ts`).
- Lock: no pin moved and the three existing wheel sets and fingerprints are unchanged (`tests/conformance/python-wheels.node.test.ts`).
- Adapter: the boot import probe resolves every hidden module in the Worker, and a withheld wheel fails the boot with `unavailable` at prepare (`packages/adapter-pyodide/test/adapter.node.test.ts`).

Observed in stage AP3 (scripted models only, no real model download):

- Streaming: checked deltas arrive in order and join to the final output, a tool turn emits content-free markers only, a mid-stream block fails `denied` without forwarding the blocked delta, surrogate pairs are never split (including across provider chunks) and abort stops events and settles `cancelled` (`python/galaxie/tests/test_adk.py`). Four streaming transcripts from native CPython with ADK's SSE mode (`stream-text`, `stream-tools`, `stream-mid-block`, `stream-abort`) reproduce on Pyodide in Node, and `stream-text` and `stream-abort` in real headless Chromium under the unchanged strict CSP (`tests/conformance/adk-python.node.test.ts`, `examples/rag-browser/test/adk-python-conformance.node.test.ts`). The native lane emulates the router's output check; the matrix records this. The `streaming` flag turns on and the matrix flag matches the adapter.

Observed in stage AP2 (scripted models only, no real model download):

- Model, tools and run: `galaxie.adk` supplies a router-backed `BaseLlm`, capability tools and the loop-exit helper, and `Executor` drives `run_async` (`python/galaxie/tests/test_adk.py`, `test_adk_lint.py`). Schema output reaches the router through an additive optional `jsonSchema` model option that requires the `structured-output` feature; payloads of the other executors are unchanged.
- Fixed failures: a raising model or capability ends the run with its code, an author callback that swallows a tool error cannot keep the run going, sibling tools are not dispatched after a fatal failure, a failed run leaves the session at its last stored point, and an abort settles within a bound and leaves the adapter usable (`tests/conformance/adk-python-run.node.test.ts`). A directly built `Gemini` agent fails in the Worker because its `fetch` stub rejects external origins; the test shows the failure, not an absence of attempts.
- Conformance lane: eight native CPython transcripts (`tests/conformance/golden-adk-python`) reproduce on Pyodide in Node, and three of them in real headless Chromium under the unchanged strict CSP (`tests/conformance/adk-python.node.test.ts`, `examples/rag-browser/test/adk-python-conformance.node.test.ts`). Requests are mapped to OpenAI format independently on each side.
- Limits: the lint aid still rejects every `google.genai` import, so author code cannot import `google.genai.types` yet; no Worker credential scan, real-model run or device measurement exists.

Required before each feature flag turns on, and before this ADR is Accepted:

- `streaming`: checked text deltas in order and a mid-stream block that forwards nothing (stage AP3, observed above).
- `interrupts` and `resume`: confirmation and long-running pauses that resume by interaction ID, with stale and mismatched IDs failing before any tool runs (stage AP4).
- `checkpoints`: reload restore of a pending interaction, integrity-key tamper refusal and the frame-size guard, with the recovery guarantees of the other durable executors (stage AP5).
- A conformance lane of native CPython goldens reproduced on Node and Chromium, a credential and content scan over logs, warnings, events, errors, spans and stored records, and the real-device or real-model checks every other executor still lists as open (stage AP6).
