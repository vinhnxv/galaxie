---
title: Spike B - In-Browser Engine Page - Plan
type: spike
date: 2026-10-29
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Spike B - In-Browser Engine Page - Plan

## Goal Capsule

- **Objective:** before M2 builds the engine worker and the Built-in AI provider, give galaxie one page that runs every candidate in-browser engine through the same functional checks and the same fixed tasks, and exports a results file. ADR-0006 needs observed answers to choose the engine to ship: does each engine load, stream, cancel, run in a worker, reset context per session, and enforce a JSON Schema while decoding; does `ChatWebLLM` work with a worker engine; what does the Prompt API report for English and Vietnamese. Download size, warm-up, time to first token, p50/p95 latency, schema-valid rate and the device are recorded as demonstrations, never as pass/fail gates (ADR-0016, brief §16.2 row B, §18).
- **Means:** a throwaway Vite page under `spikes/b-local-inference/`, in its own pnpm workspace, with one module per engine arm behind one small interface (KTD3), fixed prompts and schemas (KTD5), a measurement harness (KTD6), a results export (KTD7), a deterministic mock arm and a headless smoke script that an environment without a GPU can run (KTD8), and an optional local HTTPS mode for other devices (KTD9).
- **This plan builds the page and proves the harness. It does not run the real engines.** The real run on the maintainer's Mac (Apple M5 Pro, Chrome), the report and the ADR-0006 update are separate later tasks. They are not part of this plan's Definition of Done.
- **Authority, highest first:**
  1. `AGENTS.md` repository rules.
  2. Accepted ADRs, especially ADR-0012, ADR-0015, ADR-0016 and ADR-0017.
  3. This plan. ADR-0006 is the decision this spike feeds.
  4. `docs/galaxie-project-brief.md` §16.2 row B and §18; `docs/system-design.md` §7 and §8.4.
- **Stop conditions:**
  - Stop and report (draft PR naming the blocker) if the page can only work by editing anything under `packages/`, `tests/`, the root workspace configuration, or another spike.
  - Never lower or bypass the 7-day release-age gate. If a pinned version will not install, use the newest version the gate allows, record the change, and continue.
  - Time box: the whole plan is one implementation session. Build the arms in the order of U3–U6. If an arm cannot be made to build or to report a typed result after three distinct fix attempts, leave it reporting `unavailable` with reason `not_implemented`, record the attempts in the README, and continue with the next arm. A missing arm is a valid spike result; a crashing page is not.

---

## Product Contract

### Summary

Spike B answers, per engine, the functional questions ADR-0006 defers to it, and records demonstration numbers on real devices. This plan delivers the instrument: a page that runs four engine arms and a mock arm through identical checks and tasks, exports a versioned results file, and can be opened on other devices over HTTPS. A headless smoke run proves the harness and the results format without a GPU.

Spike code is throwaway (brief §16.2, `AGENTS.md`). It stays under `spikes/b-local-inference/`, is never promoted to `packages/`, and imports nothing from other spikes; useful code from `spikes/local-english-tutor/` is copied, with a header comment saying where it came from.

### Problem Frame

Two spikes already ran a 1.7B model on WebGPU with galaxie's own ONNX decoding loop (B0, the tutor). They showed the numbers depend on choices galaxie does not make (engine, model, quantization, device), and they compared nothing. M2 must pick the engine its worker ships and decide how the Built-in AI provider behaves. Without one page that runs every candidate the same way, that choice rests on READMEs, which brief §16.2 forbids ("observed results, not results inferred from READMEs").

Research for this plan found facts that shape the page:

- WebLLM 0.2.86 enforces a JSON Schema through XGrammar, passed as `response_format: { type: 'json_object', schema: JSON.stringify(schema) }`; the OpenAI `json_schema` form is not supported. It stops through `interruptGenerate()` (no `AbortSignal`) and resets through `resetChat()`. Its prebuilt list has no LFM model.
- `ChatWebLLM` in `@langchain/community` 1.1.29 always constructs its own in-thread `MLCEngine`; it cannot take a worker engine, and it does not pass temperature, structured output or the abort signal to the engine.
- Transformers.js v4 is stable. 4.3.1 is the newest version past the release-age gate; LFM3 support arrives only in 4.3.2, which is not yet eligible. Since 4.3.0, the experimental `@huggingface/transformers-structured-output` package adds JSON-Schema-constrained decoding as a logits processor.
- The Chrome Prompt API ships by default on desktop Chrome. Its documented languages do not include Vietnamese, and it is not exposed inside workers.
- On this Mac, Playwright's default headless shell has `navigator.gpu` but `requestAdapter()` returns `null`. The page must test for a null adapter, not for `navigator.gpu`.

### Requirements

- **R1.** The page runs five arms through one interface: `mock`, `ort-own-loop` (onnxruntime-web with galaxie's decoding loop), `webllm`, `transformers-js`, and `prompt-api`.
- **R2.** Each arm reports availability before it loads: `available`, `downloadable`, `unavailable` with a typed reason (`no_webgpu_adapter`, `no_shader_f16`, `api_missing`, `language_unsupported`, `not_implemented`), plus the raw value for the Prompt API.
- **R3.** For every available arm, the page runs the functional checks: `loads`, `streams` (at least two chunks arrive before the final result), `cancels` (an abort mid-stream ends generation, no chunk arrives after the abort settles, and a new request then succeeds), `worker` (inference runs in a dedicated worker; observed, not assumed), `resetPerSession` (a second session does not see the first session's context), and `schemaEnforcedWhileDecoding` (the engine constrains decoding to the schema, as opposed to validating afterwards). Each check records `passed`, `failed`, `not_applicable` or `not_run` with a short reason; `not_run` means the harness did not execute the check (time box, missing wiring) and must never be read as an engine property. A failed check is a result, not a page error.
- **R4.** The page runs the fixed tasks (KTD5) on every available arm: structured quiz generation with a JSON Schema, and short feedback on a learner sentence in English and in Vietnamese. It never scores answer quality.
- **R5.** The page records demonstrations per arm: bytes downloaded (or reported by the engine), cold and warm load time, warm-up time, and per run time to first token, total time, output length (tokens when the engine reports them, else characters) and schema validity. It repeats each task (default 5 measured runs after one discarded warm-up) and reports min, p50, p95 and max. No value is compared to a threshold.
- **R6.** The page records the device: user agent, Chrome version, the WebGPU adapter's `info` (vendor, architecture, description) and whether `shader-f16` is available, and the number of logical cores. It never records anything that identifies the person.
- **R7.** The page checks `ChatWebLLM` with a worker engine: whether it can be given one, whether `invoke` and `stream` work through it, and whether temperature, the JSON Schema and the abort signal reach the engine. It records what it observed.
- **R8.** The page records Prompt API `availability()` for English input and output and for Vietnamese input and output, separately.
- **R9.** The page exports one versioned results JSON file through a download button, and the same object through a dev-only `window.spikeB` handle for scripts. The file contains no prompt outputs beyond a length and a validity flag, no model weights and nothing from storage.
- **R10.** The page is served on `http://127.0.0.1:4173` by default, so it reuses the model files B0 and the tutor already cached for that origin, and on HTTPS on the local network with a separate command, so other devices get a secure context.
- **R11.** A headless smoke command runs without a GPU: the page loads, the mock arm completes every check and task, every other arm reports a typed availability without crashing, and the exported results validate against the results schema.
- **R12.** `pnpm check` and `CI=true pnpm test` still pass, existing goldens are unchanged, and nothing under `packages/`, `tests/` or another spike changes. No model weight, certificate or browser profile is committed.

### Acceptance Examples

- **AE1.** Smoke (`pnpm --dir spikes/b-local-inference smoke`, default headless shell, no adapter): the results file shows `mock` with every check `passed` and every task with 5 measured runs; `ort-own-loop`, `webllm` and `transformers-js` stop after `probe()` and show a typed availability (`unavailable` / `no_webgpu_adapter` when the browser finds no adapter, which is the expected case); `prompt-api` shows its raw `availability()` values without having called `create()`; the file validates against the results schema; the command exits 0.
- **AE2.** Mock checks are real: the smoke run also forces each mock failure mode once through a query parameter (`?mockFail=cancel`, `?mockFail=reset`, `?mockFail=schema`), and the matching check reads `failed` while the others read `passed`. This proves the checks can fail.
- **AE3.** Cancel: for the mock arm, the abort lands after the second chunk; the record shows the chunk count at abort, that no chunk arrived after the abort settled, and that the next request succeeded.
- **AE4.** Export: clicking **Download results** in the smoke run produces a file whose JSON equals `window.spikeB.results()` and contains no prompt text or output text.
- **AE5.** HTTPS: `pnpm --dir spikes/b-local-inference start:lan` serves the page over HTTPS on the LAN address; `window.isSecureContext` is `true` in a headless check against it (with the self-signed certificate accepted by the script).
- **AE6.** No arm is described as passing or failing a threshold anywhere in the page, the results file or the README.

### Scope Boundaries

- No change under `packages/`, `tests/`, other spikes, root `package.json`, `pnpm-workspace.yaml`, `vitest.config.ts`, CI or Biome configuration.
- No real-device run in this plan's Definition of Done, no results from the real engines committed by this plan, no report and no ADR-0006 edit. Those are later tasks. So is a scripted real-run launcher: the later run task writes it if it needs one, and must then keep Chrome's component updates enabled (Playwright disables them by default, which can make the Prompt API report `unavailable`). The later report task also owns the rule for choosing between engines that pass the same checks.
- No answer-quality scoring, no LLM judge, no thresholds (ADR-0016).
- No LangGraph graph; the arms are driven directly. `ChatWebLLM` is the only LangChain surface checked (R7).
- No React; plain TypeScript and DOM.

#### Considered and not built

- **LFM3 on Transformers.js.** It needs 4.3.2, which the release-age gate blocks until after this plan; the ONNX model card is also new. The Transformers.js arm uses a model 4.3.1 supports (KTD4); LFM3 stays on the own-loop arm.
- **LFM on WebLLM.** No vetted MLC build exists; community builds ship their own WASM. WebLLM uses a prebuilt model.
- **Prompt API in a worker.** The API is window-only; the arm runs on the main thread and records `worker: not_applicable`.
- **mkcert certificates.** They need a root CA installed on every device and a private key that must never be shared. The self-signed plugin gives a secure context after a click-through, which is enough for a spike.

### Key Decisions

- The page is the instrument; the real run is separate (Goal Capsule).
- One fixed set of prompts and schemas across arms, kept inside the schema features the copied JSON guide supports (KTD5), so the own-loop arm can enforce the same schema.
- Demonstrations are reported with their spread; no number is called good or bad.

---

## Planning Contract

### Key Technical Decisions

- **KTD1. Spike layout.** `spikes/b-local-inference/` follows `spikes/c-ui-path/`: its own `package.json` (`"name": "galaxie-spike-b-local-inference"`, `"private": true`, description starting "Throwaway spike:", `"license": "AGPL-3.0-only"`, `"type": "module"`, `packageManager` and `engines` copied), its own `pnpm-workspace.yaml` (copy c-ui-path's, including `minimumReleaseAge: 10080`, and add `onnxruntime-node: false` under `allowBuilds` with a comment: it is a Node-only dependency of `@huggingface/transformers` whose postinstall the page never needs, and without the entry pnpm 11 exits with `ERR_PNPM_IGNORED_BUILDS`), `pnpm-lock.yaml`, `tsconfig.json` extending `../../tsconfig.base.json` (no `jsx`; add `"lib"` entries for `DOM`, `DOM.Iterable` and `WebWorker` as the tutor does if needed), `index.html` with the HTML-comment SPDX header, `vite.config.ts`, a spike-local `.gitignore` (`node_modules/`, `dist/`, `certs/`, `results/raw/`), and `README.md`. Every `.ts` file starts with the SPDX header. Exact versions in `package.json`, no ranges.
- **KTD2. Dependencies** (exact; all published at least 7 days before 2026-10-29): `@mlc-ai/web-llm` 0.2.86; `@huggingface/transformers` 4.3.1; `@huggingface/transformers-structured-output` 4.3.1; `onnxruntime-web` `1.31.0-dev.20260914-8d85527a0`, `@huggingface/tokenizers` 0.2.0 and `@huggingface/jinja` 0.5.10 (the tutor's resolved pins, for the copied loop); `@langchain/core` 1.2.20; `@langchain/community` 1.1.29 (its transitive `@langchain/openai` and `@langchain/classic` resolve under the gate to versions that accept core 1.2.20; if pnpm resolves a version that needs core 1.3, add a `pnpm.overrides` entry in the spike's `package.json` pinning the gate-eligible version and record it); `zod` 4.6.7. Dev: `vite` 8.3.4, `@vitejs/plugin-basic-ssl` 2.3.0, `playwright` 1.64.1, `typescript` 7.0.2. If two copies of onnxruntime-web resolve (the own-loop pin and Transformers.js's own), keep both, record it in the README, and check that each arm loads its own.
- **KTD3. Arm interface.** `src/arms/types.ts`:
  ```ts
  type Availability = { status: 'available' | 'downloadable' | 'unavailable'; reason?: UnavailableReason; raw?: unknown };
  interface Arm {
    id: ArmId; model: ModelInfo; engineVersion: string; inWorker: boolean;
    probe(): Promise<Availability>;
    load(onProgress: (loadedBytes: number, totalBytes?: number) => void): Promise<LoadInfo>;
    openSession(): Promise<Session>;
    dispose(): Promise<void>;
  }
  interface Session {
    generate(request: { messages: Message[]; schema?: JsonSchema; maxTokens: number; signal: AbortSignal;
      onChunk: (text: string) => void }): Promise<{ text: string; outputTokens?: number; constrained: boolean }>;
    close(): Promise<void>;
  }
  ```
  `constrained` is what the arm actually did for that call (true only when the engine enforced the schema while decoding). Each arm maps `AbortSignal` to its engine's stop mechanism. Greedy decoding (temperature 0 or the engine's equivalent) wherever the engine lets the page set it; the Prompt API does not, so its arm records `decoding: 'browser-default'` and the others `decoding: 'greedy'`. A session is one conversation: every warm-up and measured run calls `openSession()`, one `generate()` with the task's complete messages, then `close()`, so no run sees an earlier run's context. Every `generate` reply from a worker arm also carries `executedIn`, the global-scope name read by the same worker code that ran the model for that call. An aborted `generate` settles only after the engine's own stream or loop has ended, never as soon as the abort is requested.
- **KTD4. The arms.**
  - `mock` (`src/arms/mock.ts`, in a worker): emits a fixed reply in chunks with fixed delays, honours abort, keeps per-session context so the reset check is meaningful, and returns schema-valid JSON when given a schema. `?mockFail=cancel|reset|schema` breaks one behaviour for AE2.
  - `ort-own-loop` (`src/arms/ort/`): copy the tutor's `worker.ts`, `protocol.ts`, `model-files.ts`, `json-guide.ts` and `client.ts` (header comment: "Copied from spikes/local-english-tutor/src/engine/; throwaway"). Keep B0's model, revision, file list, hashes and Cache Storage name unchanged so the cached files are reused. Add the two things the tutor lacks: a session concept (a session holds its message history; each `generate` starts from an empty KV cache, as the tutor loop already does; `close` drops the history) and a `dispose` message. The copied guide writes forced JSON structure as chunks before the model runs; keep that, and have the arm report forced and model-chosen token counts separately. Schema enforcement is the copied guide (`constrained: true`).
  - `webllm` (`src/arms/webllm.ts` + `webllm.worker.ts`): `CreateWebWorkerMLCEngine` with `WebWorkerMLCEngineHandler` in the worker; model `Qwen2.5-1.5B-Instruct-q4f16_1-MLC` from WebLLM's prebuilt list (its card names Vietnamese; if the Transformers.js arm lands on the same checkpoint, the results mark the pair as the only same-checkpoint comparison); streaming with `stream: true`; abort calls `interruptGenerate()`; a new session calls `resetChat()`; schema through `response_format: { type: 'json_object', schema: JSON.stringify(schema) }` (`constrained: true`).
  - `transformers-js` (`src/arms/transformers.ts` + worker): `pipeline('text-generation', model, { device: 'webgpu', dtype: 'q4f16' })` in a worker with `TextStreamer` and `InterruptableStoppingCriteria`. Model, first that loads under 4.3.1: `onnx-community/Qwen2.5-1.5B-Instruct`, then `onnx-community/Qwen2.5-0.5B-Instruct`, then `onnx-community/LFM2-1.2B-ONNX`; pin the Hugging Face revision of the one used and record the fallback taken. Schema through `@huggingface/transformers-structured-output` (`constrained: true`); if that package cannot be wired within the time box, generate free-form JSON with `constrained: false` and record why. Serve the onnxruntime WASM from the spike origin without copying files: in the worker, import `onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url` and `onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url` (from the onnxruntime-web copy Transformers.js resolves), assign them to `env.backends.onnx.wasm.wasmPaths`, and set `env.useWasmCache = false`. With the cache on, Transformers.js re-imports the factory from a `blob:` URL, which `script-src 'self'` blocks inside a worker; a CDN fallback hits the same block, so there is none. If the schema package is skipped under the time box, `schemaEnforcedWhileDecoding` reads `not_run`, not `failed`.
  - `prompt-api` (`src/arms/prompt-api.ts`, main thread, `inWorker: false`): `LanguageModel.availability()` with `expectedInputs`/`expectedOutputs` languages; `create()` only after a user click on **Run** (user activation), with a download monitor; `promptStreaming()` with `signal`; a new session is a new `create()` and the old one is `destroy()`ed; schema through `responseConstraint` (`constrained: true`). The Vietnamese feedback task runs only if Vietnamese reports anything but `unavailable`; otherwise it records `language_unsupported`.
- **KTD5. Fixed tasks.** `src/tasks.ts` holds the prompts and schemas; every arm gets identical messages.
  - `quiz`: system and user messages asking for exactly three multiple-choice questions on English past tense. JSON Schema (written as a Zod schema in `src/tasks.ts` and converted with `z.toJSONSchema`): object `{ questions: array (min 3, max 3) of { prompt: string (minLength 1), options: array (min 3, max 3) of string (minLength 1), answer: enum ['A','B','C'] } }`. These features (objects, bounded arrays, strings with `minLength`, enums) are exactly what the copied JSON guide supports, so all arms get the same schema. Validity is `schema.safeParse(JSON.parse(text)).success`; a parse error counts as invalid.
  - `feedback-en` and `feedback-vi`: one fixed learner sentence with an error, and a request for two or three sentences of feedback, in English and in Vietnamese. No schema. Recorded: length only.
  - `reset` probe (for R3): sessions A and B are opened together on the same loaded engine. A is told a code word; B is asked for it; then A is asked for it as the positive control. `passed` only if A repeats the word and B does not; `failed` if B produces it; `not_applicable` with reason `positive_control_failed` if A does not repeat it. Outputs are inspected in memory and never exported.
  - `schema-probe` (for `schemaEnforcedWhileDecoding`): the user message asks for a one-sentence prose answer and says not to use JSON; the request carries a schema of one object with one required key `code` whose value is an enum with the single string `zq-violet-7`. The check is `passed` only if the reply parses as JSON and equals `{ "code": "zq-violet-7" }`; post-hoc validation cannot produce that from a prose request. The arm's own `constrained` claim is recorded next to the observed result. `?mockFail=schema` makes the mock return prose.
  - `schema-coverage` (check `schemaCoverage`, recorded, never a gate): one generation with a schema holding a number, a boolean, an optional property and an `anyOf`; `passed` if the reply validates, `failed` with the reason otherwise (a guide exception counts as `failed`). This shows the coverage gap the quiz schema hides.
  - `maxTokens`: 512 for `quiz`, 160 for feedback, 64 for `schema-probe` and the reset probe, 160 for `schema-coverage`.
- **KTD6. Measurement.** `src/harness.ts` runs, per available arm: probe → first load → dispose → second load (reads the engine's cache) → checks → warm-up run (discarded) → `runs` measured runs per task (default 5, `?runs=N`) → dispose.
  - **Load times.** Each load records `loadKind` (`cold` or `warm`, from whether the arm reports reading from its cache). The first load gives the cold time when files were not cached; when they already were (for example B0's cache on 127.0.0.1:4173), the cold time is `null` with reason `already_cached`. The second load gives the warm time.
  - **Download size.** For arms that store files in the origin, the observed size is the change in `navigator.storage.estimate().usage` across the first load, with the engine-reported total beside it when there is one. WebLLM reports progress as a fraction, so its engine total may be `null`. The Prompt API's size is `null` with reason `browser_managed_fraction_only`.
  - **Timing.** `performance.now()` around calls on the main thread; time to first token is the first `onChunk`. Time to first token and tokens per second are compared across arms only for the unconstrained feedback tasks, because the own-loop guide emits forced structure before the model runs. For `quiz`, report total time to a complete reply and, for the own-loop arm, forced and model-chosen tokens separately. The `streams` and `cancels` checks run on `feedback-en`.
  - **Cancel.** The abort lands after the second chunk. Record the chunk count at abort, the time from abort to settle, whether any chunk arrived after settle, and the next request's time to first token beside the arm's median.
  - **Worker and main thread.** `worker` is `passed` only when every `generate` reply's `executedIn` is `DedicatedWorkerGlobalScope` and the arm claims a worker; the Prompt API reads `not_applicable`. During each measured run a `PerformanceObserver` for `longtask` records the count and longest main-thread task per arm (Chromium only; `null` with a reason where unsupported).
  - **Summaries.** Per task: min, p50, max and, when there are at least 20 runs, p95 (nearest rank); with fewer runs p95 is `null` with reason `fewer_than_20_runs`, because nearest-rank p95 of five runs is the max. Also `validRuns` and `distinctOutputs` (counted in memory from output hashes that are never exported), so a reader can see that greedy repeats are one sample.
  - **Order.** Arms run one at a time in the order given by `?arms=`, which the results record. The README states that GPU memory release between arms is not verified and that order and device heat can move later arms' timings, so a real run may use one page load per arm.
- **KTD7. Results file.** `src/results.ts` defines `ResultsV1` as a Zod schema: `{ schema: 'galaxie.spike-b.results/v1', createdAt, page: { commit?: string, origin }, device, arms: ArmResult[], chatWebLLM, promptApiAvailability }`. `ArmResult` holds `id`, model id and revision, engine version, `inWorker`, `decoding`, `sameCheckpointAs` (arm id or `null`), availability, checks with status and reason, both loads, long-task counts, and per-task runs and summaries. The Prompt API `availability()` values for en and vi are recorded even when that arm is `not_implemented`. The download button serializes the validated object to `spike-b-results-<date>-<arm-set>.json`. `window.spikeB` (dev and smoke only) exposes `results()`, `runAll(options)` and `status()`.
- **KTD8. Smoke.** `scripts/smoke.ts` (run with `node`), modelled on `spikes/c-ui-path/scripts/record.ts`:
  1. Start Vite with `createServer` on `127.0.0.1:4173`, launch Playwright's default headless Chromium with no flags (no adapter expected), open `/?arms=all&runs=5&promptApi=probe&probe=real`, click **Run** (user activation) and wait for `status().done`. `probe=real` makes `ort-own-loop`, `webllm` and `transformers-js` stop after `probe()` even if an adapter is found, so the smoke never downloads a model; `promptApi=probe` keeps the Prompt API arm to `availability()` and never calls `create()`. Assert AE1 and AE3.
  2. Reopen with `arms=mock` and each of `mockFail=cancel|reset|schema`; assert AE2.
  3. Click **Download results**, compare the file with `results()`, and assert it holds no prompt or output text (AE4).
  4. Start a second Vite server with `VITE_LAN=1`, pick the first non-internal IPv4 from `os.networkInterfaces()`, open `https://<lan-ip>:4443/` with `ignoreHTTPSErrors`, and assert `location.protocol === 'https:'` and `isSecureContext` (AE5). Loopback counts as a secure context even over HTTP, so 127.0.0.1 cannot test AE5. With no LAN IPv4, log AE5 as skipped with that reason; a skip does not fail the smoke.
  5. Write `results/smoke.json`, close both servers, log every assertion, and exit non-zero at the end if any failed.
- **KTD9. Serving and CSP.** `vite.config.ts` serves on `127.0.0.1:4173` with `strictPort` (the origin B0 and the tutor used, so Cache Storage is shared). `start:lan` sets `VITE_LAN=1`, which enables `@vitejs/plugin-basic-ssl` and `host: true` on port 4443; the certificate stays in Vite's cache and is never committed. The CSP header, copied from the tutor and extended: `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' https://huggingface.co https://*.hf.co https://raw.githubusercontent.com; img-src 'self' data:; style-src 'self' 'unsafe-inline'`. Add an origin only when an arm needs it, and list each with its reason in the README. Exclude `onnxruntime-web` and `@huggingface/transformers` from dependency pre-bundling, as the tutor does.
- **KTD10. `ChatWebLLM` check.** `src/chat-webllm-check.ts` constructs `ChatWebLLM` with the WebLLM arm's model, then tries to give it the worker engine by assigning the instance's `engine` field (the source creates its own `MLCEngine` in the constructor; the field is protected in TypeScript, so use a narrow cast with a comment). It records: whether construction alone starts an in-thread engine (observe whether a download or GPU init begins before `initialize`), whether `invoke` and `stream` work through the worker engine, whether `temperature`, an abort `signal` and a JSON schema passed in call options reach the engine, and whether a JSON schema can be passed at all. Do not infer this from the replies: wrap the worker engine's `chat.completions.create` and record which of those options it received. It also runs the reset probe (KTD5) through two `ChatWebLLM` conversations sharing the worker engine, and records `engineInjection: 'protected-field-overwrite'`, so the result states that worker use works only through an unsupported override. Runs only when the WebLLM arm is available.

### High-Level Technical Design

Directional sketch, not implementation:

```text
index.html → main.ts: device probe → arm probes (no loading) → [Run] (user activation)
  harness: for arm in selected arms (one at a time):
    load → checks(streams, cancels, worker, reset, schema) → warm-up → runs × tasks
    → dispose
  chatWebLLM check (if webllm available) → promptApiAvailability(en, vi)
  results (Zod-validated ResultsV1) → [Download results] / window.spikeB.results()

arms: mock(worker) | ort-own-loop(worker, copied tutor loop + JSON guide, B0 cache)
      | webllm(worker, XGrammar json_object+schema) | transformers-js(worker, structured-output pkg)
      | prompt-api(main thread, responseConstraint)
```

### Assumptions

- Playwright 1.64.1's default headless shell on CI-like environments returns a `null` WebGPU adapter; the smoke treats any adapter it does find as a bonus, not a failure, and still asserts only the mock arm's results and typed availability for the others.
- The Prompt API arm can call `availability()` without user activation, and `create()` needs it; the smoke never calls `create()`.
- WebLLM, Transformers.js and the own loop can each be loaded and disposed in one page without reloading; if GPU memory is not released, the later real run may need one page load per arm (`?arms=<id>`), which the page already supports.

### Implementation Constraints

- `AGENTS.md` rules: English only; SPDX header on every new source file; never describe galaxie as secure, compliant, certified or production-ready; no secrets; never weaken a check.
- Stage files by name; never commit `spikes/.DS_Store`, `node_modules/`, `dist/`, `.profile/`, `certs/`, model files or browser caches.
- No imports from other spikes; copied files carry a provenance comment.
- Biome must pass on the spike files.

### Sequencing

U1 → U2 → U3 → U4 → U5 → U6 → U7 → U8. U3–U6 are the real arms in priority order; under the time box a later arm may end as `not_implemented` (Goal Capsule).

---

## Implementation Units

### U1. Workspace, page shell, device probe, results schema

**Goal:** a page that loads, shows the device, the arm list and their probes, and exports a valid (empty) results file.

**Requirements:** R2, R6, R9, R10, R12.

**Dependencies:** none.

**Files:** `spikes/b-local-inference/package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tsconfig.json`, `vite.config.ts`, `index.html`, `.gitignore`, `src/main.ts`, `src/device.ts`, `src/results.ts`, `src/arms/types.ts`.

**Approach:** KTD1, KTD2, KTD3, KTD7, KTD9. `device.ts` returns the R6 fields; adapter `null` → `webgpu: { adapter: null }`. `device.ts` also records the R8 Prompt API `availability()` values for English and Vietnamese input and output (probe only, no `create()`, the minimal `LanguageModel` types declared locally), so they reach the results even if U6 is cut.

**Patterns to follow:** `spikes/c-ui-path/` (workspace, Vite `createServer` script), `spikes/local-english-tutor/vite.config.ts` (CSP header, `optimizeDeps.exclude`).

**Test scenarios:** `pnpm --dir spikes/b-local-inference install --frozen-lockfile`; `exec vite build`; `pnpm exec tsc -p spikes/b-local-inference/tsconfig.json --noEmit`; the page loads with no console errors.

**Verification:** commands pass; Biome and license checks pass.

### U2. Harness, tasks and mock arm

**Goal:** the full run works end to end on the mock arm, including forced failures.

**Requirements:** R3, R4, R5, R9, R11.

**Dependencies:** U1.

**Files:** `src/harness.ts`, `src/tasks.ts`, `src/arms/mock.ts`, `src/arms/mock.worker.ts`, `src/stats.ts`.

**Approach:** KTD3, KTD5, KTD6. The worker check uses `executedIn` from each `generate` reply (KTD3), not a separate identity message.

**Test scenarios:** exercised by U8: AE1–AE4 on the mock arm.

**Verification:** covered by U8.

### U3. ORT own-loop arm

**Goal:** LFM3-1.7B through the copied tutor loop, with sessions and dispose, reusing B0's cache.

**Requirements:** R1, R3, R5.

**Dependencies:** U2.

**Files:** `src/arms/ort/worker.ts`, `protocol.ts`, `model-files.ts`, `json-guide.ts`, `client.ts`, `index.ts`.

**Approach:** KTD4. Keep the copied loop's per-request KV cache; add `session` and `dispose` messages and `executedIn`; map `AbortSignal` to the existing `abort` message and settle only on the worker's `done` or `failed` for that request.

**Patterns to follow:** `spikes/local-english-tutor/src/engine/`.

**Test scenarios:** typecheck and build; in the smoke, `unavailable` / `no_webgpu_adapter` without loading files.

**Verification:** covered by U8; real behaviour is checked in the later real run.

### U4. WebLLM arm

**Goal:** WebLLM in a worker with streaming, interrupt, reset and XGrammar schema.

**Requirements:** R1, R3, R5.

**Dependencies:** U2.

**Files:** `src/arms/webllm.ts`, `src/arms/webllm.worker.ts`.

**Approach:** KTD4. Probe: adapter present and `shader-f16` available (the model is q4f16) else typed `unavailable`.

**Test scenarios:** typecheck and build; smoke shows `unavailable`.

**Verification:** covered by U8.

### U5. Transformers.js arm

**Goal:** Transformers.js 4.3.1 in a worker with streaming, interrupt, per-session reset and, if wired, schema-constrained decoding.

**Requirements:** R1, R3, R5.

**Dependencies:** U2.

**Files:** `src/arms/transformers.ts`, `src/arms/transformers.worker.ts`.

**Approach:** KTD4, including the model fallback order and the local WASM path. A session is a fresh message history and a fresh KV cache (no `past_key_values` carried over).

**Test scenarios:** typecheck and build; smoke shows `unavailable`.

**Verification:** covered by U8.

### U6. Prompt API arm and availability record

**Goal:** the Built-in AI arm on the main thread, and the English/Vietnamese availability record.

**Requirements:** R1, R3, R5, R8.

**Dependencies:** U2.

**Files:** `src/arms/prompt-api.ts`.

**Approach:** KTD4. Generation only; the availability record lives in U1. `?promptApi=probe` limits the arm to `availability()`.

**Test scenarios:** typecheck and build; smoke records raw availability for `en` and `vi` and never calls `create()`.

**Verification:** covered by U8.

### U7. `ChatWebLLM` check and HTTPS mode

**Goal:** R7 and R10's LAN mode.

**Requirements:** R7, R10.

**Dependencies:** U4.

**Files:** `src/chat-webllm-check.ts`, `vite.config.ts` (LAN mode), `package.json` scripts (`start`, `start:lan`, `smoke`).

**Approach:** KTD9, KTD10. When WebLLM is unavailable, the check records `not_run` with the reason.

**Test scenarios:** typecheck and build; AE5 is checked by the smoke (KTD8 step 4, U8).

**Verification:** covered by U8.

### U8. Smoke script, README and committed smoke result

**Goal:** one command proves the harness; the README tells the later real run what to do.

**Requirements:** R9, R11, R12, AE1–AE6.

**Dependencies:** U1–U7.

**Files:** `scripts/smoke.ts`, `results/smoke.json` (generated, committed), `README.md`.

**Approach:** KTD8. README in the c-ui-path layout: title "Spike B: in-browser engines", the throwaway notice, **Run it** (`start`, `start:lan` with the certificate warning, `smoke`, page query parameters, and for a real run: open `start` in the maintainer's own Chrome, use `?runs=20` so p95 is reported, run once with empty caches for cold loads, and treat a Prompt API `unavailable` from any scripted browser as unconfirmed until normal Chrome agrees), **What the page checks** (each check and how it is observed), **Arms** (model, revision, engine version, worker or not, how the schema is enforced, CSP origins each arm needs, fallbacks taken), **Results** ("Not yet run on real devices" plus the smoke result), **Limits** (no quality scoring; numbers are demonstrations and describe engine-and-model pairs, with only a same-checkpoint pair comparing engines alone; GPU memory release between arms unverified; arm order and device heat can move timings; `ChatWebLLM` worker use relies on overwriting a protected field; Prompt API has no Vietnamese per its docs). It must not contain threshold language (AE6).

**Test scenarios:** `pnpm --dir spikes/b-local-inference smoke` exits 0 with AE1–AE4 logged as passed and AE5 passed or skipped with a reason.

**Verification:** the Verification Contract.

---

## Verification Contract

- `pnpm --dir spikes/b-local-inference install --frozen-lockfile`, `pnpm --dir spikes/b-local-inference exec vite build` and `pnpm exec tsc -p spikes/b-local-inference/tsconfig.json --noEmit` pass.
- `pnpm --dir spikes/b-local-inference smoke` exits 0 with AE1–AE4 passing and AE5 passing or skipped with a reason, and `results/smoke.json` validates against `ResultsV1`.
- `pnpm check` and `CI=true pnpm test` pass at the repo root.
- `git diff main --stat -- packages tests spikes/b0-webgpu-load spikes/local-english-tutor spikes/c-ui-path pnpm-workspace.yaml package.json vitest.config.ts biome.json .github` is empty, and `git diff main -- tests/conformance/golden` is empty.
- `git ls-files spikes/b-local-inference` shows no `node_modules`, `dist`, `certs`, `.onnx`, `.wasm`, `.bin` or `.DS_Store` file.
- `grep -rniE "threshold|pass rate|good enough|fast enough" spikes/b-local-inference/README.md spikes/b-local-inference/src` finds nothing that judges a number.

## Definition of Done

- U1–U8 are committed on branch `spike/b-local-inference` with English messages.
- The Verification Contract passes.
- A ready-for-review PR against `main` lists the smoke results, each arm's model and how it enforces the schema, every fallback taken (models, WASM path, overrides, CSP origins), every arm left `not_implemented` with its attempts, and every departure from this plan.
- No Beads IDs, `internal/` content, secrets or model weights appear in tracked files, commits or the PR.
