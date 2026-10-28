# Spike B: in-browser engines

Throwaway instrument for ADR-0006, before M2. All implementation stays in this spike.
Nothing here is promoted to a package, and no source is imported from another spike.
The ORT loop's copied files name their provenance in a header comment.

## Run it

Use Node.js 24 or newer and pnpm 11 through Corepack. The smoke uses Biome from the
existing root install; engine dependencies remain isolated in this workspace:

```sh
pnpm --dir spikes/b-local-inference install --frozen-lockfile
pnpm --dir spikes/b-local-inference start
```

Open `http://127.0.0.1:4173` in the maintainer's own Chrome and click **Run**.
The origin matches B0 and the tutor, so the own-loop arm reuses their verified Cache Storage files.
The page probes every selected arm before loading anything. **Run** permits model downloads;
**Download results** exports the validated metadata and measurements, without prompt or output text.
There are no provider credentials or external inference endpoints.

```sh
pnpm --dir spikes/b-local-inference start:lan
pnpm --dir spikes/b-local-inference smoke
```

LAN mode listens on port 4443 over HTTPS. Open the printed LAN address and accept the
self-signed certificate warning on each device. The certificate and private key remain in
Vite's ignored cache; never commit or share them. The smoke accepts the self-signed certificate
only in its temporary browser context and verifies HTTPS on a non-loopback IPv4 address.

Query parameters:

| Parameter | Behavior |
| --- | --- |
| `arms=all` | Default: mock, ORT, WebLLM, Transformers.js, Prompt API, sequentially |
| `arms=webllm,transformers-js` | Select arms in this exact order; duplicate IDs are removed |
| `runs=5` | Default measured runs per task, after one discarded warm-up per task |
| `runs=20` | Includes nearest-rank p95; fewer than 20 samples report p95 as null with a reason |
| `probe=real` | Real GPU arms stop after their availability probes, even if a GPU exists |
| `promptApi=probe` | Prompt API calls availability only, never create |
| `mockFail=cancel`, `reset`, or `schema` | Break exactly one mock behavior to exercise its check |
| `tjDtype=q4` | Load the Transformers.js checkpoint as `q4` (fp32 activations) instead of `q4f16` |

For the later real run, use normal Chrome in the foreground (a background tab throttles timers
and skews timings), and `?runs=20`. For cold loads, run once in a fresh Chrome profile; clearing
site data for `127.0.0.1:4173` instead would also delete the 1.4 GB model cache that B0 and the
tutor share. The Prompt API model is managed by the browser and is not cleared by site data. Prefer one page load per arm when comparing timings. A Prompt API `unavailable`
from any scripted browser remains unconfirmed until normal Chrome agrees: scripted Chromium
can have component updates disabled.

On the loopback dev server only, `POST /__spike-b/save?name=<slug>` writes a results export
(`galaxie.spike-b.results/v1`, at most 5 MB) to `results/<slug>.json`, so a scripted real run
can save its export without a browser download. LAN mode and builds do not serve it.

Chrome's activation can expire while earlier arms run. If a Prompt API download needs a fresh
activation, the page pauses at that arm and asks for another click on the same **Run** button.
Using `?arms=prompt-api` starts with that arm. All model creation follows a Run click; probes never
create a session. Once the browser has the model available, session creation needs no new download.

## What the page checks

A failed functional check is an observation, not a page crash. `not_run` means the harness did
not execute it; it says nothing about the engine. Unavailable arms retain typed reasons.

| Check | Observation |
| --- | --- |
| loads | First load, dispose, second load; the engine reports cache state |
| streams | At least two nonempty chunks arrive before generation completes |
| cancels | Abort after chunk two, wait for generation to settle, observe callbacks for 50 ms, then succeed on another request; a failure names its cause (`no_second_chunk`, `not_aborted`, `chunk_after_settle`, `next_request_failed`) |
| worker | Every generation reply identifies `DedicatedWorkerGlobalScope`, read where inference executes; Prompt API is not applicable |
| resetPerSession | A and B coexist; B must not recall A's code word, and A must recall it as a positive control. `sessionIsolation` records what is tested: worker arms replay a history the spike keeps per session (`harness_history_replay`), so a pass there shows that history works, not that the engine isolates sessions; only the Prompt API keeps context in the engine (`native_session`) |
| schemaEnforcedWhileDecoding | An adversarial prose request must return the singleton object required by the schema; the arm's constrained claim is recorded separately, and a failure reads `parse_error` or `mismatch`. The Prompt API arm sets `omitResponseConstraintInput`, so the model cannot copy the value from the schema |
| schemaCoverage | Number, boolean, optional property and union coverage; an exception is a failed observation |

The mock emits delayed chunks in a worker, retains conversation history by session, and uses
schema fixtures. Its schema check proves the harness wiring, not an inference decoder.
The smoke runs each deliberate failure separately and requires every other check to stay passed.
The cancellation record includes chunks at abort, settle duration, chunks after settlement,
next-request success and first-token time, and the measured feedback median.

All arms receive identical fixed quiz and English/Vietnamese feedback tasks. Quiz validity uses
the fixed Zod schema after JSON parsing; feedback records lengths only. Each generation starts
with a fresh session and closes it afterwards. Timing starts after the session is open, so
first-token and total times exclude session creation (a full `create()` for the Prompt API);
`openSessionMs` records it per run. A task whose generation throws reads `failed`; `not_run`
is kept for tasks the harness never attempted. No answer-quality scoring is performed.

Measurements include storage-usage change across the first load, engine-reported bytes where
available, cold/warm load time, warm-up time, per-run total time, output length and quiz validity.
Cached first loads report cold time as null with `already_cached`; unknown cache state stays
explicit. Storage estimates describe the origin, not isolated model allocations.
Prompt API downloads are browser managed and expose fractions, so their byte counts are null.
WebLLM also exposes progress fractions rather than a byte total.

Only unconstrained feedback reports comparable first-token timing and token throughput.
The own-loop guide writes forced structure before model choices, so quiz reporting uses total
time and separates forced from model-chosen tokens. Where the engine supplies no token count,
lengths are characters and token throughput is null. Summaries report min, p50, max, p95 when
there are enough samples, valid-run counts and distinct-output counts. Output hashes stay in
memory and are not exported. Chromium long tasks record count and longest duration without
attributing them to a particular library.

## Arms

The following mechanisms are wired and build-checked. Their inference behavior has **not yet
been observed on a real device** by this task.

| Arm | Model and revision | Engine | Execution and schema mechanism |
| --- | --- | --- | --- |
| mock | `deterministic-mock`, `v1` | local mock `1` | Worker; deterministic schema fixture |
| ort-own-loop | `LiquidAI/LFM3-1.7B-ONNX`, `189271ef61b9e7fdd4a8b5b0891bcacad37700f8` | ORT `1.31.0-dev.20260914-8d85527a0` | Worker; copied JSON guide during decoding, with original file list, hashes and B0 cache name |
| webllm | `Qwen2.5-1.5B-Instruct-q4f16_1-MLC`, `9bd564b064631febf14deadcac492efb761d60c3` | WebLLM `0.2.86` | Worker; XGrammar, `json_object` plus serialized schema |
| transformers-js | `onnx-community/Qwen2.5-1.5B-Instruct`, `d54957e3af1be04546436e874a60fe386041b244` | Transformers.js `4.3.1` | Worker; `StructuredOutputProcessor` `4.3.1` as logits processor |
| prompt-api | browser-managed `LanguageModel`, revision unavailable | Browser managed | Main thread; `responseConstraint`, browser-default decoding |

WebLLM uses its prebuilt model record with a pinned Hugging Face resolve revision; its prebuilt
WASM URL is the versioned `v0_2_86/base/Qwen2-1.5B-Instruct-q4f16_1_cs1k-webgpu.wasm`
under the configured raw GitHub origin. Transformers.js uses explicit WebGPU and q4f16.
No arm selects a WASM-only backend, but with `executionProviders: ['webgpu']` onnxruntime-web can still place operators WebGPU does not support on its CPU (WASM) provider.
WebLLM's prebuilt model library URL points at the `main` branch of `binary-mlc-llm-libs`; the path is versioned, the branch is not pinned.

The Transformers.js load order, if an earlier candidate cannot load on the later device, is:

1. Qwen2.5 1.5B, revision above.
2. `onnx-community/Qwen2.5-0.5B-Instruct`, `22942cb7d7ba4cc81bb4673549ca4d4614469b5e`.
3. `onnx-community/LFM2-1.2B-ONNX`, `dd095948cf23919ef2fcb635a156ce59975f35ff`.

The first successful checkpoint is pinned for every replacement worker in that page load.
A later reload failure is recorded rather than switching the cold/warm pair to another model.
Cache labels observe native Cache reads/writes through the existing Transformers.js custom-cache
hook, retaining its backend, name, keys and native Cache identity. Progress events do not
establish downloads; unobservable cache state is recorded as unknown.

Candidate revisions were obtained from Hub metadata, without loading weights. Actual selection
and skipped candidate IDs are exported if the later load takes a fallback. No model fallback
was taken in this task. The two Qwen2.5 1.5B arms are the only same-checkpoint pair; the result
marks that relationship only while that candidate remains selected. Other comparisons describe
engine-and-model pairs.

Transformers.js serves its ORT asyncify `.mjs` factory and `.wasm` from this spike origin via
Vite URL imports, with `env.useWasmCache = false`. Its dependency and the own loop resolve
exactly the same ORT version, so there is one installed copy and no cross-version WASM routing.
This is the planned local-WASM path; there is no CDN fallback and no blob script permission.

All dependencies are exact pins in this workspace. The seven-day release-age gate is unchanged.
No version substitutions or pnpm overrides were needed. pnpm reports peer-version warnings for
community's optional Transformers.js v3 peer and Stagehand's unused OpenAI/Zod peers; this page
uses Transformers.js v4 directly and imports only community's WebLLM chat subpath. Transitive
`@langchain/classic` `1.0.54` and `@langchain/openai` `1.6.3` accept core `1.2.20`.
`onnxruntime-node` and protobufjs build scripts remain disabled as declared in the workspace.

### CSP origins

The response header applies to page and worker responses. No origin was added beyond KTD9:

| Source | Reason |
| --- | --- |
| `'self'` | Page modules, workers, local WASM/factory, Vite dev connection and origin caches |
| `https://huggingface.co` | Pinned model configuration, tokenizer and model files for the GPU arms |
| `https://*.hf.co` | Hugging Face large-file CDN redirects |
| `https://raw.githubusercontent.com` | WebLLM prebuilt versioned model WASM |
| `blob:` in worker-src only | Worker creation paths supported by engine libraries; script-src does not allow blob |
| `data:` in img-src only | In-page image data; no network destination |

`script-src` is exactly `'self' 'wasm-unsafe-eval'`; WebAssembly compilation needs the latter.
`style-src 'self' 'unsafe-inline'` allows the page's static styles and Vite's style handling.
There is no unsafe-eval or inline-script permission, and no provider-key input.

## Results

The real run is `results/2026-10-29-apple-m5-pro-chrome155.json`: Apple M5 Pro (24 GB, WebGPU
adapter `apple` / `metal-3` with `shader-f16`), Chrome 155.0.8059.86, `?arms=all&runs=20`,
one page load, foreground tab, models already cached. Every number below is a demonstration on
this one device and setup, never a pass/fail gate (ADR-0016). No other device has run the page yet.

### Functional checks per arm

| Check | ORT own loop | WebLLM | Transformers.js | Prompt API |
| --- | --- | --- | --- | --- |
| loads | passed | passed | passed | passed |
| streams | passed (110 chunks) | passed (26) | **failed** (1 chunk) | passed (63) |
| cancels | passed | passed | **failed** (`no_second_chunk`) | passed |
| worker | passed | passed | passed | not applicable (window only) |
| resetPerSession | passed | not applicable (positive control) | not applicable (positive control) | passed (`native_session`) |
| schemaEnforcedWhileDecoding | passed | passed | passed | passed |
| schemaCoverage | **failed** (`check_exception`) | passed | **failed** (`parse_error`) | **failed** (`check_exception`), intermittent |
| quiz schema-valid runs | 20 of 20 | 20 of 20 | 0 of 20 | 20 of 20 |

Models: the ORT loop runs `LiquidAI/LFM3-1.7B-ONNX` (q4f16, B0's cached files); WebLLM runs
`Qwen2.5-1.5B-Instruct-q4f16_1-MLC`; Transformers.js runs `onnx-community/Qwen2.5-1.5B-Instruct`
(q4f16); the Prompt API runs Chrome's browser-managed model. The mock arm passed every check.

What the failures and not-applicable results mean:

- **Transformers.js 4.3.1 produced degenerate text on this device.** With q4f16, the 1.5B model
  writes `I` followed by `!` up to the token cap, so the streamer releases one chunk at the end,
  cancellation sees no second chunk, and no quiz parses. A manual check outside the export
  loaded `Qwen2.5-0.5B-Instruct` q4f16 through the same worker: it streamed 20 chunks, but its
  text also degenerated into repeated fragments. With `tjDtype=q4`, session creation failed for
  every candidate with `std::bad_alloc`. The ORT pin is the one Transformers.js 4.3.1 declares,
  and the ORT loop arm runs the same pin correctly with LFM3. Whether the cause is the Qwen
  exports, an ORT WebGPU kernel in this dev build, or the device was not isolated.
- **WebLLM's positive control.** The other session answered `Unknown.`, so no context leaked.
  Session A, asked to recall, answered that it did not know the code word, which leaves the
  check without a positive control. Manual calls outside the export showed the cause: the
  harness does replay the history (asked "What code word did I give you in my previous
  message?", the same session answered `zq-violet-7`), but the recall prompt's "If none, say
  unknown" makes Qwen2.5-1.5B deny it. The remember prompt now asks the model to repeat the
  word, after Qwen refused the earlier "Remember the code word" wording.
- **Schema coverage.** The copied ORT guide supports strings, enums, objects and bounded
  arrays, not numbers, booleans or unions; it throws on this schema by design. The Prompt API
  coverage probe threw in two of three full runs on this Mac and passed in the third; four
  direct calls afterwards all returned valid JSON. The harness does not keep the exception
  text, so the cause is not recorded.
- **Vietnamese on the Prompt API.** `availability()` returned `available` for English and
  `unavailable` for Vietnamese and for English input with Vietnamese output, so the
  Vietnamese feedback task was skipped with `language_unsupported`.

`ChatWebLLM` (`@langchain/community` 1.1.29) with a worker engine: invoke and stream worked,
but only after overwriting a protected engine field, and the call's temperature, JSON Schema
and abort signal did not reach the engine. Its reset check had no positive control, as above.

### Demonstrations, Apple M5 Pro, Chrome 155

Twenty measured runs per task after one discarded warm-up; total time is p50 / p95 in ms.
First-token time and throughput are for unconstrained feedback only. Output length is in tokens,
except for the Prompt API, which reports no token count (characters). Each arm runs a different
model except the Qwen pair, so these numbers do not rank engines.

| Arm | Quiz total | Feedback EN total | Feedback EN first token p50 | Tokens/s p50 | Feedback length p50 |
| --- | --- | --- | --- | --- | --- |
| ORT own loop (LFM3-1.7B) | 1170 / 1203 | 1806 / 1863 | 135 | 94.3 | 160 tokens (cap) |
| WebLLM (Qwen2.5-1.5B) | 1261 / 1273 | 267 / 284 | 45 | 117.7 | 27 tokens |
| Transformers.js (Qwen2.5-1.5B) | 8882 / 8966 | 2695 / 2761 | 2695 (single chunk) | null | 160 tokens (cap) |
| Prompt API (browser model) | 3782 / 4582 | 1509 / 2810 | 109 | null | 304 characters |

Vietnamese feedback matched English within a few percent on the three worker arms. Greedy
worker arms produced one distinct output per task; the Prompt API produced 20 distinct outputs
per task, because its decoding is the browser default. Cancellation settled 0-12 ms after the
abort on the arms whose cancel check passed, with no chunk after settlement. No long task was
observed on the main thread in any arm.

Loads. The final run had every model cached. Warm loads were 1.8 s (ORT), 0.7-0.8 s (WebLLM),
3.8-4.0 s (Transformers.js) and 1 ms to 5.1 s (Prompt API, whose first create in a page took
5.1 s). An earlier run on the same day, before the harness fixes in this branch, recorded the
first downloads: WebLLM 30.9 s and 881,839,104 bytes of storage growth; Transformers.js 39.7 s
and 1,228,926,720 bytes (engine-reported 1,228,919,513). The ORT loop reported 1,401,135,508
bytes, already cached by B0. Chrome downloaded the Prompt API model after a second Run click;
that first load, including the wait for the click, the download and the first `create()`,
took about 119 s. These downloads ran on one home
connection, so their times describe that connection as much as the engines.

### Proposed ADR-0006 update

This proposal waits for the maintainer's approval; ADR-0006 is unchanged until then.

**Proposal: WebLLM is the in-browser engine for the MVP, behind a thin galaxie adapter, not
`ChatWebLLM`.**

- WebLLM is the only engine that passed loads, streams, cancels, worker execution, schema
  enforcement while decoding and the broader schema coverage probe on this device. It enforces a
  JSON Schema while decoding through XGrammar (`response_format` with a schema).
- Its reset check could not confirm the positive control with the current prompt (see above).
  galaxie's adapter keeps conversation history per session and calls `resetChat()` before each
  request, so per-session isolation is galaxie's own replay, as for every worker arm.
- `ChatWebLLM` fails the condition in ADR-0006 decision 3: with a worker engine it needs an
  unsupported field overwrite, and it drops temperature, the schema and the abort signal. The
  adapter calls the worker engine's OpenAI-style API directly.
- The ORT own-loop arm passed every check except schema coverage and stays the fallback if
  WebLLM regresses. It would make galaxie own the tokenizer, chat template, decoding loop and
  a JSON-guide that today covers only strings, enums, objects and bounded arrays.
- Transformers.js does not qualify on this device with the 4.3.1 pin: its Qwen2.5 output
  degenerated and `q4` sessions failed to allocate. ADR-0006 decision 8 (non-LLM tasks after the
  MVP) is unaffected.
- The Prompt API passed its checks for English and stays the Built-in AI provider of decision 2.
  It reported Vietnamese unavailable, and its coverage probe failed intermittently.

Costs of the proposal to record in the ADR's Consequences: models must be MLC-compiled, so the
model list follows the MLC catalog (LFM3 was not tried on WebLLM); the WebGPU model library
comes from the unpinned `main` branch of `binary-mlc-llm-libs`, so the adapter must pin a
library URL or host it; and the evidence covers one Mac and one Chrome version.

### GPU-free smoke

`results/smoke.json` is the GPU-free harness run. The smoke validates it against
`galaxie.spike-b.results/v1`, downloads the same JSON through the button, checks that
prompt/output text is absent, and blocks all external network requests.
AE1-AE4 exercise the mock, all real-arm probes and the export. Additional GPU-free fixtures
reject post-result chunks and extra singleton keys, pin checkpoint reloads, and check repeat-run
and thrown-check ChatWebLLM records. AE5 verifies LAN HTTPS or records
an explicit skip if no non-internal IPv4 exists. AE6 checks the README's measurement language.

Neither export contains model text, browser storage contents or output hashes. The smoke JSON
includes arm order, device metadata and the loopback page origin; AE5 does not write its LAN
address.

Validation commands:

```sh
pnpm check
CI=true pnpm test
pnpm --dir spikes/b-local-inference install --frozen-lockfile
pnpm exec tsc -p spikes/b-local-inference/tsconfig.json --noEmit
pnpm --dir spikes/b-local-inference exec vite build
pnpm --dir spikes/b-local-inference smoke
```

## Limits

- Numbers are demonstrations, with no answer-quality score. Greedy repeats can be one distinct
  output rather than independent samples.
- GPU memory release between arms is not verified. Arm order and device heat can move later
  timings; use one page load per arm when appropriate.
- Main-thread long-task observations include all activity during a measured run; they do not
  identify a cause. Long tasks unsupported by the browser report null with a reason.
- Time to first token is the first chunk the engine streams. WebLLM streams per token; the
  Transformers.js `TextStreamer` and the copied ORT loop release text at word boundaries, so
  their first chunk can land a token or two later.
- "Greedy" means no sampling, not identical decoding: Transformers.js applies the model's
  `generation_config` penalties, WebLLM applies its `mlc-chat-config` penalties, and the ORT
  loop applies its own repetition penalty. The same-checkpoint pair also differs in quantization
  (MLC q4f16_1 against ONNX q4f16). `sameCheckpointAs` is set only when both arms loaded.
- Cancellation's post-settlement observation is finite (50 ms). It cannot prove
  the absence of arbitrarily late callbacks. Worker promises settle after their engine loop ends.
- The copied ORT guide supports the quiz's strings, enums, objects and bounded arrays. It does
  not implement the broader coverage probe's number/boolean/union features; exceptions stay
  visible as failed check results. Its original token budget can also end a guided reply early.
- `ChatWebLLM` worker use overwrites a protected engine field through an unsupported override.
  The check observes constructor fetch/GPU activity for 50 ms, then observes invoke/stream
  and option forwarding at the injected engine boundary. `schemaAccepted` is true only when the schema
  reached the engine and the call succeeded. The supplied signal is observed
  as an option, not interpreted from model replies. Results remain not_run in the smoke.
- The Prompt API needed a second Run click for its model download on the Mac run; the page then
  shows that it is creating the session. Combined English and Vietnamese output options were not
  exercised, because Vietnamese was unavailable. A task error is recorded rather than crashing
  the page.
- Tokens per second needs at least two chunks: a reply that arrives as one chunk has no decode
  interval to divide by and reports null.
- Prompt API model identity and revision cannot be pinned, and decoding is browser default.
  The API does not expose the common interface's per-call output-token cap. Its docs do not
  list Vietnamese; that feedback task is skipped with `language_unsupported` when availability
  for English input with Vietnamese output (`enToVi`) is unavailable. Scripted-browser unavailability is unconfirmed.
- No engine is left `not_implemented`. Build-time integration fixes were a WebLLM chunk-evidence
  type, an explicit optional-WASM-backend check for Transformers.js, and a narrow call-parameter
  type for the ChatWebLLM observation wrapper.
- A worker load failure now rejects with each candidate's error name and message (never model
  text), visible to page code and the console; the export still records only `load_failed`.

### Implementation departures

- A shared spike-local worker RPC transports mock and Transformers.js sessions, cancellation,
  progress and generation-scope evidence. It adds one helper file rather than duplicating that
  protocol in each arm.
- Results additionally record fallback candidate IDs, arm order and run count explicitly.
- `api_unavailable` extends the reason enum for an existing Prompt API whose English probe
  returns unavailable. The raw value alone cannot establish language or hardware as the cause.
- The Node smoke loads the shared schemas/tasks through Vite SSR so runtime imports resolve
  the repository-required `.js` specifiers to TypeScript without adding a loader dependency.
  It formats the generated artifact with the existing root Biome tool so regeneration preserves
  the repository formatting check; this adds no dependency.
- Prompt API can require a second Run click for fresh activation after earlier arms. This keeps
  the recorded sequential order and prevents creation outside a user gesture when downloading.
- Prompt API cannot enforce the shared per-call token cap through its current API; that limit
  is recorded above rather than claiming the requested cap was applied.

The Mac run and this report followed as separate work; the ADR-0006 update waits for approval.
