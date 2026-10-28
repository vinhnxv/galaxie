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

For the later real run, use normal Chrome, `?runs=20`, and one empty-cache visit to record
cold loading. Prefer one page load per arm when comparing timings. A Prompt API `unavailable`
from any scripted browser remains unconfirmed until normal Chrome agrees: scripted Chromium
can have component updates disabled. This task never runs the real engines or downloads models.

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
| cancels | Abort after chunk two, wait for generation to settle, observe callbacks for two animation frames, then succeed on another request |
| worker | Every generation reply identifies `DedicatedWorkerGlobalScope`, read where inference executes; Prompt API is not applicable |
| resetPerSession | A and B coexist; B must not recall A's code word, and A must recall it as a positive control |
| schemaEnforcedWhileDecoding | An adversarial prose request must return the singleton object required by the schema; the arm's constrained claim is recorded separately |
| schemaCoverage | Number, boolean, optional property and union coverage; an exception is a failed observation |

The mock emits delayed chunks in a worker, retains conversation history by session, and uses
schema fixtures. Its schema check proves the harness wiring, not an inference decoder.
The smoke runs each deliberate failure separately and requires every other check to stay passed.
The cancellation record includes chunks at abort, settle duration, chunks after settlement,
next-request success and first-token time, and the measured feedback median.

All arms receive identical fixed quiz and English/Vietnamese feedback tasks. Quiz validity uses
the fixed Zod schema after JSON parsing; feedback records lengths only. Each generation starts
with a fresh session and closes it afterwards. Session setup and teardown are included in wall
clock measurements. No answer-quality scoring is performed.

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
There is no silent WASM inference fallback.

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

**Not yet run on real devices.** `results/smoke.json` is the GPU-free harness run only.
The smoke validates it against `galaxie.spike-b.results/v1`, downloads the same JSON through
the button, checks that prompt/output text is absent, and blocks all external network requests.
AE1-AE4 exercise the mock, all real-arm probes and the export. Additional GPU-free fixtures
reject post-result chunks and extra singleton keys, pin checkpoint reloads, and check repeat-run
and thrown-check ChatWebLLM records. AE5 verifies LAN HTTPS or records
an explicit skip if no non-internal IPv4 exists. AE6 checks the README's measurement language.
The committed smoke has AE1-AE6 passed, all mock checks passed, and five measured runs for
each of its three tasks. All three GPU arms reported `no_webgpu_adapter`; Prompt API raw
availability was English `downloadable` and Vietnamese `unavailable`, with no create call.
The additional harness, checkpoint and Chat record regressions also passed.

The committed smoke JSON includes arm order, device metadata and the loopback page origin.
AE5 does not write its LAN address. A later LAN run records its page origin as the results
schema requires. No export contains model text, browser storage contents or output hashes.

Validation commands:

```sh
pnpm check
CI=true pnpm test
pnpm --dir spikes/b-local-inference install --frozen-lockfile
pnpm exec tsc -p spikes/b-local-inference/tsconfig.json --noEmit
pnpm --dir spikes/b-local-inference exec vite build
pnpm --dir spikes/b-local-inference smoke
```

`pnpm check` was run after each unit. Existing conformance goldens and the compatibility matrix
remain unchanged, as do packages, tests and every other spike.

## Limits

- Numbers are demonstrations, with no answer-quality score. Greedy repeats can be one distinct
  output rather than independent samples.
- GPU memory release between arms is not verified. Arm order and device heat can move later
  timings; use one page load per arm when appropriate.
- Main-thread long-task observations include all activity during a measured run; they do not
  identify a cause. Long tasks unsupported by the browser report null with a reason.
- Cancellation's post-settlement observation is finite (two animation frames). It cannot prove
  the absence of arbitrarily late callbacks. Worker promises settle after their engine loop ends.
- The copied ORT guide supports the quiz's strings, enums, objects and bounded arrays. It does
  not implement the broader coverage probe's number/boolean/union features; exceptions stay
  visible as failed check results. Its original token budget can also end a guided reply early.
- `ChatWebLLM` worker use overwrites a protected engine field through an unsupported override.
  The check observes constructor fetch/GPU activity for two frames, then observes invoke/stream
  and option forwarding at the injected engine boundary. A schema accepted as a call option can
  still be ignored; the forwarding fields distinguish this. The supplied signal is observed
  as an option, not interpreted from model replies. Results remain not_run in the smoke.
- Prompt API system-role handling and activation for combined language options remain unverified
  until the later normal-Chrome run. A task error is recorded rather than crashing the page.
- Prompt API model identity and revision cannot be pinned, and decoding is browser default.
  The API does not expose the common interface's per-call output-token cap. Its docs do not
  list Vietnamese; that feedback task is skipped with `language_unsupported` when the actual
  Vietnamese availability is unavailable. Scripted-browser unavailability is unconfirmed.
- No engine is left `not_implemented`. Build-time integration fixes were a WebLLM chunk-evidence
  type, an explicit optional-WASM-backend check for Transformers.js, and a narrow call-parameter
  type for the ChatWebLLM observation wrapper. No real-engine download or inference was attempted.

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

The plan is unchanged. The later Mac run, report and ADR-0006 update remain separate work.
