---
title: In-Browser RAG Example in JavaScript and Python - Plan
type: feat
date: 2026-10-30
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# In-Browser RAG Example in JavaScript and Python - Plan

## Goal Capsule

- **Objective:** a visitor opens one page, lets their own browser embed a public corpus or any text they paste, and asks questions that get answers citing the passages they came from. The page lets them run the same agent written in LangGraph.js or in LangGraph Python. Both run the same graph, make the same search calls and send the same prompts; with the mock model a test proves their transcripts are identical, while real in-browser models can word answers differently between runs. No server embeds, searches or generates.
- **Means:** a new maintained example, `examples/rag-browser`, with EmbeddingGemma 2 and Orama in one retrieval Worker behind a host capability (KTD2, KTD7). Stage 2 adds a minimal `@galaxie/adapter-pyodide` and a Python `galaxie` package so the Python graph runs on the same host (KTD12, KTD14).
- **Authority, highest first:**
  1. `AGENTS.md`. In particular: everything committed is English, SPDX headers on new source files, the ADR-0012 baseline is never weakened, galaxie is never described as secure or compliant, and spike code is never promoted.
  2. Accepted ADRs, especially ADR-0002, ADR-0006, ADR-0012, ADR-0014, ADR-0016 and ADR-0017. Do not edit an Accepted ADR.
  3. ADR-0018 (Proposed). Its decisions bind stage 2. KTD8 narrows which decisions this example exercises and changes none of them. Only its Verification section and Revisions line may change.
  4. This plan.
  5. The project brief.
- **Execution profile:** autonomous. Node 24, pnpm 11, uv with CPython 3.14, headless Chromium through Playwright.
  - Network is needed for `pnpm install`, `uv`, the Python wheel fetch script (U9), and the optional corpus and model downloads during manual checks. Tests never use the network.
  - Stage 1 is U1–U8. Stage 2 is U9–U13. Open one pull request per stage against `main`, with stage 2 branched from stage 1, and run `pnpm check` before each.
- **Stop conditions:** stop, open a draft pull request that names the blocker, and report it when any of these happens:
  - A change to a public type exported by `packages/core` is required. Stage 2 must fit the existing `ExecutorAdapter`, `ModelPort` and `CapabilityPort` contracts.
  - An existing test assertion, golden, or the compatibility matrix would change.
  - An Accepted ADR, or any ADR-0018 decision, would change.
  - Any page or Worker (retrieval, WebLLM or Pyodide) needs a CSP or Trusted Types relaxation beyond KTD11, such as `'unsafe-eval'`, `'unsafe-inline'`, a `blob:` or `data:` script source, or a Trusted Types script policy. If only Pyodide needs it, stage 2 stops and stage 1 still ships.
  - A Python dependency has no Pyodide-compatible wheel and no same-name pure-Python stand-in under ADR-0018 decision 10.
  - `pnpm check` still fails after three focused attempts on the same cause.
  - Stage 2 is blocked. Stage 1 still ships as its own pull request.
- **Who finishes:** the implementing agent opens the pull requests and stops. It never merges. If its environment forbids git operations, it leaves the work uncommitted on disk and reports that.

---

## Product Contract

### Summary

Add `examples/rag-browser`, a page that builds a vector index in the browser and answers questions from it with citations. A Node script turns the SQuAD v1.1 validation split into a corpus file. On the page, EmbeddingGemma 2 embeds that corpus, plus anything the visitor pastes, on WebGPU in a Worker. The vectors are indexed in Orama for full-text, vector and hybrid search.

A LangGraph agent searches through a host capability and answers through the existing router and in-browser models. The agent is written twice, in LangGraph.js and in LangGraph Python, and a test with the mock model proves both produce the same transcript. An evaluation button reports recall and MRR on validation questions as a demonstration.

### Problem Frame

galaxie claims an agent pipeline can run on the user's machine with no agent backend. No example shows the data side of that claim: building and searching an index in the browser. The brief lists retrieval as a gated Phase 5 item (`docs/galaxie-project-brief.md:1472`), and the maintainer opened that gate on 2026-10-30 with this use case.

ADR-0018 says Python agents can run through Pyodide with all policy in JavaScript, but only a throwaway spike backs it. A showcase that runs the same agent in both languages on one host is the first evidence a developer can open and check.

### Key Decisions

- **A maintained example, not a spike.** (session-settled: user-directed — chosen over a throwaway spike under `spikes/`: the user wants a lasting showcase.) Governs R15, R16.
- **SQuAD v1.1 validation split only.** (session-settled: user-directed — chosen over validation plus train: about 2k passages index quickly in the browser.) Governs R1.
- **English retrieval only.** (session-settled: user-directed — chosen over Vietnamese retrieval: a simpler first corpus and tokenizer.) Governs R7.
- **EmbeddingGemma 2 for embeddings.** (session-settled: user-directed — chosen over bge-small-en-v1.5: newer and denser, and the point is to show off in-browser indexing.) Governs R3.
- **Orama for the index and search.** (session-settled: user-directed — chosen over a custom index: it gives full-text, vector and hybrid search in one library.) Governs R7.
- **The browser builds the index and caches it.** (session-settled: user-approved — chosen over a prebuilt index shipped as a pinned asset, which brief §1.4 describes: the demo exists to show that the browser can index any text.) Governs R3, R5.
- **Generation uses the existing in-browser providers.** (session-settled: user-directed — chosen over building an LFM3 provider first: the engine decision `galaxie-fjl` is still open.) Governs R9.
- **The agent ships in both LangGraph.js and LangGraph Python.** (session-settled: user-directed — chosen over a JavaScript-only example: the example must show that galaxie code works in both languages.) Governs R12, R14.
- **Stage 1, the JavaScript version, ships first and alone.** (session-settled: user-approved — chosen over one combined delivery: a stage 2 problem must not hold back the JavaScript demo.) Governs R16.

### Requirements

**Corpus**

- R1. A Node script turns the SQuAD v1.1 validation split into one corpus file holding each distinct context once, plus every question with its answers and source context. It pins the source by URL and SHA-256 and refuses a mismatch.
- R2. The corpus file is never committed. The file and the page both carry the CC BY-SA 4.0 notice and the SQuAD attribution.

**Indexing**

- R3. After the visitor agrees to a download whose size is stated, the page embeds every corpus passage with EmbeddingGemma 2 on WebGPU in a Worker and shows progress.
- R4. The visitor can paste any text. The page splits it into passages and indexes them alongside the corpus. Pasted text never leaves the browser.
- R5. The built index survives a reload and is reused only when it was built with the same model, settings and corpus. "Clear data" removes the index and all pasted text.
- R6. Without WebGPU, the page reports a fixed message and indexes nothing. It never falls back silently to WebAssembly (ADR-0006 item 8).

**Search and answers**

- R7. The visitor chooses full-text, vector or hybrid search for each question.
- R8. The agent reaches the index only through the host read capability `docs.search@1`, whose result size is bounded.
- R9. The agent answers through `host.langchain.chatModel(role)` with an in-browser model, and its answer cites only passages that the search returned.
- R10. Retrieved passages reach the model as delimited data, never as instructions. A test shows that an injected passage cannot make the agent call another capability, produce a URL or send a request.

**Evaluation**

- R11. An evaluation button runs a sample of validation questions through each search mode and reports recall@1, recall@5, recall@10 and MRR. These figures are demonstrations, never gates (ADR-0016).

**Python**

- R12. The visitor can switch the page to the LangGraph Python version of the same agent. The switch states the extra download and cold start. Each answer names the executor that produced it.
- R13. The Python side holds no credential, provider, policy, budget or label logic. Model calls and capability calls cross a versioned JSON bridge, and JavaScript checks every reply before Python sees it (ADR-0018 decisions 3–5).
- R14. For one scripted session with the mock model and mock embedder, the JavaScript agent on Node and Chromium, the Python agent in Pyodide on Node and Chromium, and the Python graph on CPython all produce the same transcript (KTD15).

**Delivery**

- R15. Every TypeScript test runs in CI on Node and headless Chromium, and every Python test runs on CPython 3.14 in the same workflow. All use mocks and a committed synthetic fixture, without network at test time.
- R16. Stage 1 works and ships with no stage 2 code present.

### Success Criteria

- On the maintainer's Apple M5 Pro with Chrome, a cold visit indexes the whole validation corpus and answers a validation question with a correct citation. The README records index time, index size, per-query latency, download bytes, Python cold start and the evaluation figures, as demonstrations.
- A developer can read the JavaScript and Python graphs side by side and see the same nodes and state, with only model and capability wiring differing.

### Scope Boundaries

- Not built: an LFM3 or ONNX Runtime chat provider, Vietnamese retrieval, a prebuilt shipped index, a retrieval or vector API in `packages/core`, and answer-quality scoring beyond the R11 figures.
- Not built: pydantic-ai, DSPy, the language-tutor port, Python interrupts, Python checkpoints, and session restore after reload (KTD8).
- Not built: a generated manifest for the rag-browser agents. ADR-0018 decision 10's wheel inventory in the manifest stays with the tutor port.
- Considered and not built: coordination between two tabs that build the index at once. Each write replaces the record under the same fingerprint, so the only cost is duplicate work. Evidence of a corrupted cache would change this call. "Clear data" across tabs is coordinated (KTD6), because a second tab could otherwise write deleted pasted text back.
- Considered and not built: removing one pasted text at a time. Only "Clear data" removes pasted text, and the page says so.
- Considered and not built: retrying a failed model-file download automatically. The visitor presses the button again. Evidence that partial downloads stick would change this call.

### Deferred to Follow-Up Work

- Upgrade Transformers.js to 4.3.2 or later once it passes the 7-day release-age gate (about 2026-11-03), then drop the own-fetch workaround if the hang fix makes it unnecessary (KTD3).
- Streaming Python model calls over the bridge.
- A LangGraph Python version of the language tutor, which needs interrupts, the byte-record port and `galaxie-2fg`.

### Sources

- SQuAD v1.1: Rajpurkar et al., 2016, CC BY-SA 4.0 (`https://huggingface.co/datasets/rajpurkar/squad`).
- EmbeddingGemma 2, Apache-2.0: `https://huggingface.co/google/embeddinggemma-2`; ONNX export at `onnx-community/embeddinggemma-2-ONNX`, revision `daa72c51243991dfcaf9f9137d2c573d8f7790c0`.
- Orama 3.1.18, Apache-2.0: `https://github.com/oramasearch/orama`.
- Pyodide spike evidence: `spikes/python-bridge/README.md`, `spikes/python-bridge/summary.json` and `spikes/python-bridge/requirements.json`.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **One example package holds the host and both agents.** `examples/rag-browser` contains the host, the JavaScript graph and the Python graph. Splitting the agent into its own package, as `examples/english-tutor` does, only pays off with a generated manifest, which this plan does not build.
- KTD2. **One retrieval Worker owns the embedder and the Orama index.** A query then costs one round trip from page to Worker, and the Trusted Types policy needs one more worker URL, not two. The page talks to it through a small typed message protocol that rejects unknown or oversized messages with a fixed error.
- KTD3. **Transformers.js is pinned to exactly 4.3.1, with our own download and hash check.** 4.3.1 is the first version that registers `embedding_gemma2`. It also hangs forever when an `.onnx_data` download fails (issue #1801).
  - The Worker downloads the five pinned files itself, checks each size and SHA-256, and stores them in its own Cache Storage. The library must then resolve all five files from that cache only and never fetch. In 4.3.1 that takes `env.allowRemoteModels = false`, `env.allowLocalModels = true` with a fixed same-origin `env.localModelPath`, `env.useBrowserCache = false`, and `env.useCustomCache = true` with `env.customCache` a `match`/`put` wrapper over the verified cache, keyed by the path the library builds. With both remote and local models off, `getModelFile` throws before reading any cache. Confirm these names against the 4.3.1 source (`src/utils/hub.js`, `src/utils/cache.js`).
  - `env.remotePathTemplate` hard-codes the revision, which also stops the tokenizer's probe of `main`.
  - Loading uses `AutoConfig` with `vision_config` and `audio_config` set to null, then `AutoModel` and `AutoTokenizer`. The `feature-extraction` pipeline is not used because it loads every encoder.
  - The Worker passes `device: 'webgpu'` and `dtype: 'q4'`. With that device a missing GPU throws, which gives R6 its failure path.
  - The ONNX Runtime `.mjs` and `.wasm` are self-hosted through Vite `?url` imports, pinned to the exact `onnxruntime-web` version Transformers.js bundles. `env.useWasmCache = false` keeps `blob:` out of `script-src`.
- KTD4. **Embedding settings.**
  - Passages are truncated at 256 tokens and embedded in batches of 8, which stays under the model card's limit of about 2,700 tokens per WebGPU batch.
  - Vectors are cut to 256 dimensions and re-normalized.
  - Queries use the prefix `task: search result | query: `. Passages use `title: <title> | text: <text>`, and pasted passages use `title: none`.
  - These values, plus the `q4` dtype and the `webgpu` device, sit in one settings object. The settings feed the cache fingerprint (KTD6), so changing any of them forces a rebuild.
- KTD5. **Orama settings.**
  - Schema: `id`, `title`, `text`, `source` (`squad` or `pasted`) and `embedding: vector[256]`. Vectors are inserted as plain arrays, because Orama rejects `Float32Array`.
  - The tokenizer splits on `/[^\p{L}\p{N}]+/u` and lowercases, with stemming off. Orama's default English splitter drops non-ASCII letters.
  - The vector similarity threshold is set explicitly. The default of 0.8 drops many relevant EmbeddingGemma hits, which score about 0.68–0.87. The value is measured and recorded in U4.
  - Hybrid search keeps the default 0.5/0.5 weights. A weight of 0 silently reverts to the default, so the page never offers 0.
  - The index is persisted with Orama's `save()` and restored with `create()` using our schema and tokenizer, then `load()`. The persistence plugin is not used: its `restore()` drops the custom tokenizer and schema, and its `seqproto` format drops vectors.
- KTD6. **The cache is its own IndexedDB database.** It is named `galaxie-rag:<appId>`, separate from the checkpoint saver's `galaxie:<appId>`, whose version changes would supersede it.
  - One record holds the saved index and the pasted passages, keyed by a fingerprint. The fingerprint is the SHA-256 of: the model revision, the KTD4 settings, the exact Transformers.js and `onnxruntime-web` versions, the tokenizer rule, the Orama schema version and the corpus file's SHA-256.
  - A fingerprint mismatch discards the record and rebuilds.
  - "Clear data" deletes the database. Each write replaces the whole record.
  - Every cache write and "Clear data" run under one Web Lock named after the database. "Clear data" also posts a `BroadcastChannel` notice that makes other tabs' Workers drop their pasted passages and close their connection, so another tab cannot write deleted pasted text back.
  - "Clear data" keeps the downloaded model files in Cache Storage, and its label says so. A separate "Remove downloaded model" action deletes them.
  - The cache lives outside `@galaxie/storage-indexeddb`, so its retention sweep, principal scoping and logout wipe do not apply. Pasted text stays on the device until "Clear data" or browser eviction, and the page says so next to the paste box.
- KTD7. **`docs.search@1` is an `in-browser` read binding, and its passage text is labeled `private-user`.** The index can hold pasted text, and output labels are a static property of the schema (`packages/core/src/capability-broker.ts:468-471`), so every search marks the run `private-user`. The query is `freeText` labeled `private-user` too.
  - That pins every model role to `in-browser`, which matches the only routes this example has.
  - The output schema caps `k` at 10 and each passage at 4,000 characters, which keeps it inside the default payload budget.
- KTD8. **No durable session restore, in either language.** Each question is one run. The JavaScript agent uses `MemorySaver`, and the Python graph runs without a checkpointer. The Pyodide adapter declares `interrupts`, `resume` and `checkpoints` as false.
  - The ADR-0018 byte-record port and the executor-aware `RecoverySession` (`galaxie-2fg`) are therefore not needed here. They stay with the tutor port, which needs interrupts.
  - This narrows ADR-0018 for this use: the plan records it in ADR-0018's Verification section and changes no ADR-0018 decision.
- KTD9. **The corpus comes from the official SQuAD v1.1 `dev-v1.1.json`.** That file is the same validation split as the Hugging Face dataset, in plain JSON. The Hugging Face copy is Parquet, which would need a Parquet parser dependency for one script. The script pins the URL and SHA-256 and writes `examples/rag-browser/public/data/squad-dev.json` in the format `galaxie.rag-corpus/v1`. That path is git-ignored.
- KTD10. **Consent for the embedding model is a host button.** It states 233.6 MB before any request: 206.7 MB of model files plus 26.9 MB of ONNX Runtime. Chat models keep the host-local pattern: a "Prepare models" click, and the router's download hook for Built-in AI (`examples/host-local/src/runtime.ts:225-268`). The router's consent covers chat models only (`packages/core/src/models.ts:119-134`).
- KTD11. **CSP and Trusted Types follow host-local, with one default policy in both modes.** The policy allows exactly the bundled worker URLs: the retrieval Worker and the WebLLM Worker, and in stage 2 the Pyodide Worker.
  - Mock mode changes host-local's `trusted-types 'none'` to that policy, because the retrieval Worker must start in mock mode too.
  - Every page and Worker response keeps `script-src 'self' 'wasm-unsafe-eval'` and `require-trusted-types-for 'script'`, and never adds `'unsafe-eval'`, `'unsafe-inline'` or `blob:`. `connect-src` is `'self'` in mock mode, plus `https://huggingface.co https://*.hf.co https://raw.githubusercontent.com` in default mode. The last host serves the WebLLM model library, as in host-local (`examples/host-local/src/csp.ts:16`).
- KTD12. **The Pyodide adapter is minimal and follows ADR-0018.** Its executor ID is `langgraph-python`, and all five `ExecutorFeatures` flags are false.
  - Bridge messages are `galaxie.bridge/v1` JSON of at most 1 MB, carrying the ops `boot`, `run`, `model`, `capability`, `abort` and `result`. Unknown or malformed messages get fixed errors on both sides (ADR-0018 decision 5).
  - Abort sends an `abort` message. If the Worker does not acknowledge within 500 ms, the adapter terminates it, fails the run `cancelled`, and boots a new Worker on the next run.
  - The host supplies a `createWorker` function, so the host's Trusted Types policy stays in charge of the worker URL.
  - Services are `{ chatModels }`, keyed by provider ID with the same `BaseChatModel` or credential-factory shape as `LangGraphServices.chatModels`, so the host reuses its providers. `prepare` checks them against `ModelPreparation.providers`.
  - The `ModelPort` arrives per run in `RunRequest.models`, not at `prepare`. `RoutedChatModel` is not exported from `@galaxie/adapter-langgraph`, so the adapter runs the lease sequence itself for each bridge `model` op:
    1. `models.begin(role, { signal })`;
    2. convert the bridge messages to `@langchain/core` messages;
    3. invoke the selected provider, built from `call.credential` when one is leased;
    4. `checkOutput(text, { final: true })` before replying;
    5. `end(usage)` from `usage_metadata`, or `fail()` on error.
  - The adapter may import `@langchain/core`. It never imports `@langchain/langgraph*` or `@galaxie/adapter-langgraph`.
- KTD13. **Python wheels are self-hosted and hash-pinned.** No runtime CDN is used.
  - The Pyodide runtime files come from the npm package `pyodide@314.0.7`.
  - The Pyodide packages and PyPI wheels the graph needs are listed with SHA-256 in `python/requirements.lock`. The lock holds only the dependency closure of `langgraph` and `langchain-core` that the RAG graph resolves. Take versions from `spikes/python-bridge/requirements.json` but leave out `pydantic-ai-slim`, `pydantic-graph`, `httpx2`, `httpx2-jsfetch`, `genai-prices`, `griffelib`, `logfire-api`, `opentelemetry-api` and anything only they require. A fetch script downloads them into the git-ignored `.cache/python-wheels/`, checks every hash, and the host serves them same-origin.
  - The Worker checks each locked file's SHA-256 again before installing it, through Pyodide's lockfile `sha256` with `checkIntegrity` or by installing from verified bytes.
  - The `galaxie` and `ormsgpack` wheels, the agent sources and Pyodide's own runtime files are build outputs served same-origin. They carry the same trust as the page's JavaScript bundle. `loadPyodide` fetches `pyodide.asm.wasm` and `pyodide.asm.mjs` itself from `indexURL`, so the Worker cannot bind those bytes. The adapter README states this limit. A host that serves these files from a CDN needs SRI or pinned hashes (ADR-0018 decision 10), which this example does not build.
  - `uuid-utils` uses the Pyodide wheel 0.19.0. `ormsgpack` uses a same-name pure-Python stand-in, version 1.13.0, over `msgpack`.
- KTD14. **The Python `galaxie` package lives in `python/galaxie`, outside the pnpm workspace.** It is built into a wheel with uv. It contains `galaxie.langchain` (`GalaxieChatModel`) and `galaxie.capabilities` (`call`), plus a private bridge module that the tests replace with a fake transport. The stand-in sits in `python/standins/ormsgpack`.
- KTD15. **A parity transcript records behavior, not timing or streaming.** It is a list of: each capability call's name and input, each model call's role and messages, and the final run output. JavaScript streams and stage 2 Python does not, so chunks and content-free events are left out. The golden transcript lives at `examples/rag-browser/test/golden/session.json`.
- KTD16. **CI gains a Python lane in stage 2, delivered by U12.** Stage 1's `pnpm check` needs no Python. The workflow installs uv with CPython 3.14, the CPython line Pyodide 314 tracks, then runs the wheel fetch script before tests. `pnpm check` runs `pnpm test:python`, which runs pytest on CPython for the `galaxie` package and the parity graph. It fails with a fixed message naming uv when uv is missing.

### Pinned Inputs

These values were fetched and checked on 2026-10-30. Use them as written; do not re-derive them.

SQuAD v1.1 dev (KTD9): `https://rajpurkar.github.io/SQuAD-explorer/dataset/dev-v1.1.json`, 4,854,279 bytes, SHA-256 `95aa6a52d5d6a735563366753ca50492a658031da74f301ac5238b03966972c9`. It holds version `1.1`, 48 articles, 2,067 distinct contexts and 10,570 questions.

EmbeddingGemma 2 text-only q4 files (KTD3), at `https://huggingface.co/onnx-community/embeddinggemma-2-ONNX/resolve/daa72c51243991dfcaf9f9137d2c573d8f7790c0/<path>`:

| Path | Bytes | SHA-256 |
|---|---:|---|
| `config.json` | 5,031 | `8d011bfe08b5e345bbe0b81e5c6fd02c381920b345b986047bc2a33ce7b90d1d` |
| `tokenizer.json` | 32,170,510 | `4d777ef5bdc1aa36227abdfb77c3e49e7b9c892d16e1b6bda41c393504828be4` |
| `tokenizer_config.json` | 1,599 | `17bd5d6e9364ca49a534e1502076593317c298d4a663623091ed45388f004874` |
| `onnx/model_q4.onnx` | 490,742 | `f9eeba97acddf139b8ee2ddf04bc30dceafa88de93fadf74d7644e0d61a477a9` |
| `onnx/model_q4.onnx_data` | 174,028,800 | `c3975f2d1ab7a1878ae31a7d7a9b7804a827aff3800b60dfceafce21cac3df49` |

The ONNX Runtime `.mjs` and `.wasm` come from the `onnxruntime-web` version that `@huggingface/transformers@4.3.1` depends on, pinned through `pnpm-lock.yaml`. They need no separate hash.

### High-Level Technical Design

Components and trust boundaries. The core, the router, the broker and the host bindings stay on the main thread. Each Worker only computes.

```mermaid
flowchart TB
  subgraph Page[Main thread]
    UI[Page UI: consent, paste, ask, mode, executor switch, evaluate]
    Core[galaxie core: runtime, router, broker, labels, budgets]
    Bind[docs.search@1 binding, in-browser]
    JSA[LangGraph.js agent]
    PA[adapter-pyodide]
  end
  subgraph RW[Retrieval Worker]
    Emb[EmbeddingGemma 2 on WebGPU, or mock embedder]
    Ora[Orama index]
  end
  subgraph PW[Pyodide Worker]
    PyG[LangGraph Python graph]
    PyPkg[galaxie Python proxies]
  end
  WL[WebLLM Worker or Built-in AI]
  IDB[(IndexedDB galaxie-rag:appId)]
  UI --> Core
  Core --> JSA
  Core --> PA
  PA <-->|galaxie.bridge/v1| PyPkg
  PyG --> PyPkg
  JSA -->|capability call| Core
  Core --> Bind
  Bind <--> RW
  Emb --> Ora
  RW <--> IDB
  Core -->|routed model call| WL
```

One question, whichever agent runs:

```mermaid
sequenceDiagram
  participant V as Visitor
  participant H as Host page
  participant A as Agent (JS or Python)
  participant B as Broker
  participant R as Retrieval Worker
  participant M as Router and model
  V->>H: question and mode
  H->>A: start run
  A->>B: docs.search@1 {query, mode, k}
  B->>R: validated input
  R-->>B: passages
  B-->>A: validated, labeled passages
  A->>M: rag.answer messages with delimited passages
  M-->>A: checked reply
  A-->>H: {answer, citations}
  H-->>V: answer with cited passages
```

Index lifecycle in the retrieval Worker:

```mermaid
stateDiagram-v2
  [*] --> Empty
  Empty --> Restoring: cache record found
  Restoring --> Ready: fingerprint matches
  Restoring --> Empty: fingerprint differs, record dropped
  Empty --> AwaitingConsent: real mode, model files missing
  Empty --> Building: mock mode, or all model files verified in cache
  AwaitingConsent --> Downloading: visitor agrees
  Downloading --> Building: files verified
  Downloading --> Failed: size, hash or network failure
  Building --> Ready: all passages embedded, record saved
  Building --> Failed: WebGPU unavailable or device lost
  Ready --> Building: text pasted (incremental)
  Ready --> Empty: Clear data
  Failed --> AwaitingConsent: retry
```

### Output Structure

```text
examples/rag-browser/
  package.json, index.html, vite.config.ts, tsconfig.json, README.md
  scripts/build-corpus.ts
  public/data/            git-ignored corpus output
  src/corpus.ts
  src/retrieval/          protocol, worker, embedder, mock embedder, model files, chunking, index, cache, client
  src/agent/              definition, schemas, graph, prompt, citations, python definition (stage 2)
  src/host/               main, app, runtime, csp, trusted types, evaluate, mock script, webllm worker
  agent_py/rag_agent/     graph.py, citations.py (stage 2)
  test/                   fixtures, golden, unit, browser and node tests
packages/adapter-pyodide/ (stage 2)
python/galaxie/           (stage 2)
python/standins/ormsgpack/ (stage 2)
python/requirements.lock  (stage 2)
docs/adr/0019-in-browser-retrieval.md
```

### Assumptions

- Chrome on the reference device can run the WebLLM Worker and the retrieval Worker on WebGPU at the same time. This has not been measured. If it fails, the page indexes before preparing chat models, and the README records the limit.
- LangGraph Python's dependencies resolve on Pyodide 314.0.7 as they did in the spike, with the two package gaps the spike found.
- The in-browser chat models write `[n]` markers often enough to cite passages. The manual default-mode run checks this over several validation questions, and the README records how often answers carried at least one valid citation.

---

## Implementation Units

| U-ID | Title | Key files | Depends on |
|---|---|---|---|
| U1 | Retrieval ADR | `docs/adr/0019-in-browser-retrieval.md` | none |
| U2 | Corpus format and builder | `examples/rag-browser/scripts/build-corpus.ts`, `src/corpus.ts` | U1 |
| U3 | Embedder and pinned model files | `src/retrieval/embedder.ts`, `model-files.ts`, `mock-embedder.ts` | U2 |
| U4 | Index, cache and retrieval Worker | `src/retrieval/index.ts`, `cache.ts`, `worker.ts`, `client.ts` | U3 |
| U5 | JavaScript agent | `src/agent/graph.ts`, `citations.ts`, `definition.ts` | U4 |
| U6 | Host page | `src/host/*`, `vite.config.ts` | U5 |
| U7 | Stage 1 repo wiring and docs | root `package.json`, `scripts/check-dependencies.ts`, docs | U6 |
| U8 | Retrieval injection test | `test/injection.test.ts` | U5 |
| U9 | Python `galaxie` package and wheels | `python/galaxie/*`, `python/requirements.lock`, `scripts/fetch-python-wheels.ts` | U7 |
| U10 | Pyodide adapter | `packages/adapter-pyodide/*` | U9 |
| U11 | Python RAG agent and executor switch | `agent_py/rag_agent/*`, `src/agent/definition-python.ts` | U10 |
| U12 | Cross-language parity lane | `test/golden/session.json`, `test/parity*.ts`, `.github/workflows/ci.yml` | U11 |
| U13 | Stage 2 docs and evidence | ADR-0018 Verification, docs | U12 |

### U1. Retrieval ADR

- **Goal:** record the retrieval stack and the opening of the Phase 5 retrieval gate before any code.
- **Requirements:** R3, R5, R7, R8.
- **Dependencies:** none.
- **Files:** `docs/adr/0019-in-browser-retrieval.md`, `docs/adr/README.md`, `docs/galaxie-project-brief.md` (one pointer in the §16.7 retrieval row).
- **Approach:**
  1. Write ADR-0019 as Proposed, using the template in `docs/adr/README.md`. Context: the use case and the gate opened on 2026-10-30.
  2. Decisions: KTD2–KTD7 and KTD10. Name the brief's "prebuilt pinned asset" and record the deviation. The gate asks for the index format, update path and download size; answer it with the cache fingerprint, rebuilding on mismatch, and the 233.6 MB figure. State that these answers cover browser-built indexes only: the prebuilt pinned-index format of brief §1.4 and its update path stay undesigned, and the §16.7 pointer says so.
  3. Record the licenses: SQuAD CC BY-SA 4.0 with attribution, EmbeddingGemma 2 Apache-2.0, Orama Apache-2.0, Transformers.js Apache-2.0. Do not describe galaxie as secure or compliant.
  4. Verification: point to U4–U6 tests and the README demonstration figures.
- **Patterns to follow:** `docs/adr/0018-python-agents-through-pyodide.md` and commit `bc566fb` for how a use case opens a gate.
- **Test expectation:** none, documentation only. The `check:docs` link check covers it.
- **Verification:** the ADR index lists 0019, and `pnpm check:docs` passes.

### U2. Corpus format and builder

- **Goal:** turn SQuAD v1.1 dev into the corpus file, and commit a synthetic fixture for tests.
- **Requirements:** R1, R2, R15.
- **Dependencies:** U1.
- **Files:** `examples/rag-browser/package.json`, `examples/rag-browser/scripts/build-corpus.ts`, `examples/rag-browser/src/corpus.ts`, `examples/rag-browser/test/fixtures/corpus.json`, `examples/rag-browser/test/corpus.test.ts`, `.gitignore`.
- **Approach:**
  1. `src/corpus.ts` defines the `galaxie.rag-corpus/v1` zod schema:
     - `format`, `license`, `attribution`, `source: { url, sha256 }`;
     - `passages: [{ id, title, text }]`;
     - `questions: [{ id, question, answers: string[], passageId }]`.
     Parsing returns a typed corpus or a fixed error.
  2. The script fetches the pinned URL, checks the SHA-256, deduplicates contexts in order, and assigns passage IDs from the article and paragraph index. It writes the JSON with keys in a stable order. The URL, size and hash are in Pinned Inputs.
  3. The package script `corpus` runs it. `pnpm check` and CI never run it (KTD9).
  4. The fixture is about 12 original, synthetic English passages under 3 titles, with 10 questions. It never copies SQuAD text.
- **Patterns to follow:** `examples/english-tutor/package.json` for package fields and the SPDX header. Pin dependencies to exact versions as `examples/host-local/package.json` does.
- **Test scenarios:**
  - A SQuAD-shaped input with two questions on the same context yields one passage and two questions pointing at it.
  - Answers keep their order, and duplicates in the source are kept as given.
  - A source whose SHA-256 differs makes the converter fail with a fixed message and write nothing. Test the pure conversion and hash-check functions, not the network fetch.
  - The committed fixture parses with the schema.
  - A corpus missing `license` or `attribution` is rejected.
- **Verification:** the conversion tests pass on Node and Chromium. Running `corpus` once by hand writes about 2k passages and 10,570 questions, recorded in the README.

### U3. Embedder and pinned model files

- **Goal:** embed passages and queries in the Worker with the real model, or with a deterministic mock in tests and mock mode.
- **Requirements:** R3, R6, R15.
- **Dependencies:** U2.
- **Files:** `examples/rag-browser/src/retrieval/model-files.ts`, `examples/rag-browser/src/retrieval/embedder.ts`, `examples/rag-browser/src/retrieval/mock-embedder.ts`, `examples/rag-browser/src/retrieval/settings.ts`, `examples/rag-browser/test/model-files.test.ts`, `examples/rag-browser/test/mock-embedder.test.ts`, `examples/rag-browser/test/embedder.test.ts`.
- **Approach:**
  1. `model-files.ts` lists the five files with the byte sizes and SHA-256 values in Pinned Inputs. It downloads into a dedicated Cache Storage name, reports byte progress, checks size and hash, and deletes a failed file (KTD3).
  2. `embedder.ts` configures Transformers.js as KTD3 says. It embeds in batches as KTD4 says and returns 256-dimension unit vectors as plain arrays. It reports the device it used.
  3. `mock-embedder.ts` hashes each token into a 256-dimension bag of words and normalizes it. Shared words then score high, which lets tests check vector and hybrid ranking with no model.
  4. Both implement one embedder interface, and the Worker picks one at start-up.
- **Execution note:** test `model-files.ts` with an injected fetch and an in-memory cache. The real model never loads in CI.
- **Patterns to follow:** `spikes/local-english-tutor/src/engine/model-files.ts` for the verify-then-cache shape. Reimplement it; never copy spike code into the example. Device probing follows `spikes/b-local-inference/src/device.ts` in the same way.
- **Test scenarios:**
  - A file whose bytes match its size and hash is cached and returned, and progress ends at the file's size.
  - A file with one wrong byte is rejected with a fixed error and removed from the cache.
  - A cached file loads with no fetch call.
  - A network failure produces a fixed error, not a hang.
  - The mock embedder returns identical vectors for identical text and unit-length vectors of 256 numbers.
  - With the mock, the query "capital of France" scores a passage about Paris above an unrelated passage.
  - Re-normalizing a cut vector gives length 1 within 1e-6.
  - Starting the real embedder without `navigator.gpu` fails with the fixed WebGPU message and never selects WebAssembly. Use a stubbed global in Chromium.
- **Verification:** the tests pass on Node and Chromium. A manual default-mode run reports `webgpu` as the device.

### U4. Index, cache and retrieval Worker

- **Goal:** build, search, persist and clear the Orama index in one Worker behind a typed protocol.
- **Requirements:** R3, R4, R5, R7.
- **Dependencies:** U3.
- **Files:** `examples/rag-browser/src/retrieval/index.ts`, `examples/rag-browser/src/retrieval/chunk.ts`, `examples/rag-browser/src/retrieval/cache.ts`, `examples/rag-browser/src/retrieval/protocol.ts`, `examples/rag-browser/src/retrieval/worker.ts`, `examples/rag-browser/src/retrieval/client.ts`, `examples/rag-browser/test/index.test.ts`, `examples/rag-browser/test/chunk.test.ts`, `examples/rag-browser/test/cache.test.ts`, `examples/rag-browser/test/worker.test.ts`.
- **Approach:**
  1. `index.ts` creates the Orama database as KTD5 says and inserts passages with their vectors. Search takes a query, a mode and `k`, and returns passages with scores. `save()` and `load()` round-trip the index.
  2. `chunk.ts` splits pasted text on blank lines and packs paragraphs into passages of at most 1,000 characters. A longer paragraph is split at sentence ends, and empty input yields nothing.
  3. `cache.ts` stores and loads the KTD6 record and deletes the database on clear.
  4. `protocol.ts` defines the messages: `init`, `consent`, `paste`, `search` (with an optional `source` filter), `clear` and `remove-model`, and the events `progress`, `ready` and `failed`. Messages are validated with zod, capped at 1 MB, and fixed errors never carry content.
  5. `worker.ts` runs the lifecycle in the High-Level Technical Design. `client.ts` is the page-side wrapper the binding and UI use.
  6. Measure and set the vector similarity threshold, recording the value and how it was chosen in a code comment and the README.
- **Patterns to follow:** `examples/host-local/src/webllm-worker.ts` for worker bootstrapping. The zod usage follows `examples/english-tutor/src/schemas.ts`.
- **Test scenarios:**
  - With the fixture and the mock embedder, full-text search for a title word returns that title's passages first.
  - Vector search returns the passage that shares most words with the query, and a passage below the threshold is left out.
  - Hybrid search ranks a passage that matches both lexically and by vector above one that matches only one way.
  - The tokenizer keeps "café" and "naïve" as single tokens, and "café" finds the passage that contains it.
  - `k` above 10 is rejected by the protocol.
  - A saved index loads back and returns the same results for the same three queries.
  - In Chromium IndexedDB, a record with a matching fingerprint restores without embedding. Assert that the mock embedder is not called.
  - A record whose fingerprint differs is dropped and rebuilt.
  - "Clear" removes the database, and the next start builds from scratch with no pasted passages.
  - Two tabs in Chromium: after tab A clears, tab B pastes, and the stored record holds only B's new paste, never A's earlier pasted passages.
  - After "Clear", a start with all model files verified in the cache builds without asking for consent.
  - Pasting two paragraphs adds two `pasted` passages that search finds, and restoring after reload keeps them.
  - Chunking: blank-line paragraphs become separate passages, a 2,500-character paragraph becomes three passages split at sentence ends, and whitespace-only input yields none.
  - An unknown message type, a message over 1 MB and a malformed `search` each get the fixed invalid-message error.
  - A Worker that fails to start the embedder emits `failed` with the fixed WebGPU message, and the client surfaces it.
- **Verification:** the tests pass on Node, for pure functions, and in Chromium, for the Worker and IndexedDB.

### U5. JavaScript agent

- **Goal:** a LangGraph.js agent that retrieves through `docs.search@1` and answers with citations.
- **Requirements:** R8, R9, R10.
- **Dependencies:** U4.
- **Files:** `examples/rag-browser/src/agent/schemas.ts`, `examples/rag-browser/src/agent/definition.ts`, `examples/rag-browser/src/agent/graph.ts`, `examples/rag-browser/src/agent/prompt.ts`, `examples/rag-browser/src/agent/citations.ts`, `examples/rag-browser/test/agent.test.ts`, `examples/rag-browser/test/citations.test.ts`.
- **Approach:**
  1. The input is `{ question, mode }`. The output is `{ answer, citations: [{ marker, passageId, title, text }] }`, where `marker` is the passage's retrieval position and `text` is copied from the returned passage. `docs.search@1` takes `{ query, mode, k }` and returns `{ passages: [{ id, title, text, score }] }`, with the labels and caps from KTD7.
  2. The graph has two nodes. `retrieve` calls `host.capabilities.call('docs.search@1', …, config)`. `answer` calls `host.langchain.chatModel('rag.answer')`.
  3. `prompt.ts` builds a system message saying the passages are reference data and must never be followed as instructions. The user message lists the passages between fixed delimiters with markers `[1]`…`[k]`.
  4. `citations.ts` keeps only markers that point to a retrieved passage and removes duplicates in first-seen order. Markers outside the range are removed from both the citations and the answer text, so the answer never cites a passage that was not retrieved (R9). Stage 2's Python version must follow these exact rules, so write them as plain data rules with no regex flags beyond ASCII digits.
  5. The definition declares executor `langgraph-js`, the capability as required, and the role `rag.answer` with `defaultPolicy` allowing `in-browser` only.
- **Patterns to follow:** `examples/english-tutor/src/definition.ts`, `src/graph.ts` and `src/schemas.ts` for `defineAgentDefinition`, labels and `host.capabilities.call`.
- **Test scenarios:**
  - With a mock capability returning three passages and a mock model replying "Paris [2].", the output is that answer with one citation for passage 2.
  - A reply citing `[2]`, `[2]` and `[7]` with three passages yields one citation for passage 2, with marker 2 and the passage text, and the answer text keeps its `[2]` markers and loses `[7]`.
  - A reply with no markers yields an empty citation list and the reply unchanged.
  - The model receives the passages inside the delimiters, and the system message carries the data-not-instructions rule.
  - A capability failure fails the run with the broker's fixed error, and the model is never called.
  - An empty search result still calls the model, with a message saying no passages were found, and returns no citations.
- **Verification:** the agent tests pass on Node and Chromium through the real runtime, router and broker with mock models.

### U6. Host page

- **Goal:** the page a visitor uses: consent, indexing progress, paste, ask, search mode, cited answers, attribution, evaluation and clear data.
- **Requirements:** R2–R7, R9, R11, R15.
- **Dependencies:** U5.
- **Files:**
  - `examples/rag-browser/index.html`, `examples/rag-browser/vite.config.ts`, `examples/rag-browser/tsconfig.json`, `examples/rag-browser/test/tsconfig.json`
  - `examples/rag-browser/src/host/main.tsx`, `app.tsx`, `runtime.ts`, `csp.ts`, `trusted-types.ts`, `evaluate.ts`, `mock-script.ts`, `webllm-worker.ts`
  - `examples/rag-browser/test/csp.test.ts`, `examples/rag-browser/test/evaluate.test.ts`, `examples/rag-browser/test/loop.node.test.ts`
- **Approach:**
  1. `runtime.ts`:
     - binds `docs.search@1` with `destination: 'in-browser'`, `kind: 'read'`, `grantScope: 'instance'`, `approval: 'none'`, `retry: 'none'` and a timeout that covers query embedding;
     - routes `rag.answer` to `builtin` and `webllm` as host-local does, with mock providers in mock mode;
     - passes host-local's demonstration output-safety hook;
     - turns on `developmentWarnings` only when `import.meta.env.DEV` is set.
  2. `app.tsx` shows the states from the High-Level Technical Design:
     - the KTD10 consent button with its byte figure, then progress;
     - a paste box, a question box, and a mode selector for full-text, vector and hybrid;
     - the answer, labeled with the executor that produced it, and citations as a numbered list using the same `[n]` as the answer, each showing the passage title and text;
     - the CC BY-SA attribution next to the corpus status, "Clear data" (labeled as keeping downloaded model files) and "Remove downloaded model".
     All model and passage text renders as React text only. Only the final `{ answer, citations }` renders, for both executors.
  3. Page states:
     - The question box and Ask are disabled, with a visible reason, until the index is Ready and chat models are prepared. Embedding consent comes first, then "Prepare models".
     - During a run, a status line shows the run status and a Cancel button aborts the run.
     - An answer with no citations shows the fixed notice "No retrieved passage is cited for this answer." When the search returned nothing, the page shows "No passages matched this question in <mode> search." and suggests another mode.
     - A `failed` event shows its fixed message and a Retry button.
     - The paste box accepts at most 200,000 characters and shows a fixed message above that, before anything is sent. After a paste, a status line shows embedding progress, then how many passages were added. A fixed note beside the box says pasted text is stored on this device until "Clear data" (KTD6).
  4. Layout and accessibility follow host-local and host-remote:
     - one column that works at phone width, ordered status and consent, then question, mode and answer, then paste, evaluation and attribution;
     - a visible label on every control, `role=status` for progress and run status, `role=alert` for failures, and focus moved to the answer heading after a successful run;
     - `ModelRoutes` beside the run status.
  5. `evaluate.ts` samples 200 questions with a fixed seed and shows N beside the figures. Each question is searched in each mode through the normal `search` message, filtered to `source: 'squad'`, without the model, with `k = 10`. A hit is the question's source passage appearing in the results. The button is disabled until the index is Ready, shows "n of N" progress and has Cancel. The page shows recall@1/5/10 and MRR.
  6. With no corpus file present, the page says how to run the `corpus` script and still accepts pasted text.
  7. `csp.ts` and `trusted-types.ts` follow KTD11.
- **Patterns to follow:**
  - `examples/host-local/src/` for each matching file: CSP, Trusted Types, mock-script isolation, the "Prepare models" click and Vite inputs;
  - `examples/host-local/test/loop.node.test.ts` for build, preview and Playwright request recording.
- **Test scenarios:**
  - `csp.test.ts`: mock mode sets `connect-src 'self'` and the default policy; default mode adds only the Hugging Face hosts and `raw.githubusercontent.com`; both modes keep `require-trusted-types-for 'script'` and contain no `'unsafe-eval'`, `'unsafe-inline'` or `blob:` in `script-src`.
  - The Trusted Types policy accepts the two bundled worker URLs and throws for any other URL.
  - `evaluate.test.ts`: given fixed search results, recall@1/5/10 and MRR come out to hand-computed values. A question whose passage never appears adds 0 to MRR.
  - Loop in mock mode with the fixture:
    - the page indexes on load and answers a fixture question with the expected cited passage;
    - pasting a paragraph makes a question about it cite the pasted passage;
    - after a reload, the index restores with no rebuild progress shown;
    - "Clear data" empties the pasted passages.
  - Loop in mock mode: every request is same-origin, no request body or URL contains the pasted text or the question, and no CSP violation is reported.
  - Loop in default mode: until consent, no request goes to a Hugging Face host and no `.wasm` loads.
  - Loop: the page shows the attribution text and the license link.
  - Loop in mock mode: Ask is disabled with its reason before the index is Ready; a mock reply without markers shows the no-citation notice; an empty search shows the no-match notice; a paste over the limit shows the fixed message and sends nothing; the paste-storage note renders.
  - Loop in mock mode: evaluation is disabled before Ready, and Cancel stops it.
  - Loop with `navigator.gpu` stubbed away in default mode: after consent, the page shows the fixed WebGPU message and Retry.
  - Chromium keyboard-only test: complete consent, a question and a paste.
- **Verification:** the loop tests pass headless. A manual default-mode run on the reference device completes the Success Criteria, and the figures go into the README.

### U7. Stage 1 repo wiring and docs

- **Goal:** make the new example part of `pnpm check` and the docs.
- **Requirements:** R15, R16.
- **Dependencies:** U6.
- **Files:**
  - root `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `vitest.config.ts`, `scripts/check-dependencies.ts`, `tests/conformance/eslint-rag-agent.node.test.ts`
  - `examples/rag-browser/README.md`, `README.md`, `AGENTS.md`, `llms.txt`
  - `docs/device-matrix.md`, `docs/unsupported.md`, `docs/system-design.md`
- **Approach:**
  1. Add the example to the explicit `typecheck`, `typecheck:ts6` and `build` lists in the root `package.json`.
  2. Add an `allowBuilds` denial for `onnxruntime-node`, `sharp` and `protobufjs` in `pnpm-workspace.yaml`, as `spikes/b-local-inference/pnpm-workspace.yaml:8-11` does.
  3. Add vitest aliases and `optimizeDeps` entries for Orama. Exclude Transformers.js and ONNX Runtime from optimization.
  4. Add a `check:deps` block for `examples/rag-browser`. Its import allowlist keeps the mock script and `@galaxie/models/mock` reachable only through the mock-mode dynamic import, and keeps Transformers.js inside `src/retrieval/`.
  5. The example README covers: what it shows, how to run the corpus script, mock and default modes, download sizes, measured figures labeled as demonstrations, licenses and attribution, and limits. Limits include no session restore, one tab at a time for building, an index that is lost if the browser evicts site data, and a cache outside galaxie storage's retention and logout rules. The README also says the page builds the index in the browser to show that any text can be indexed, and that a host with a fixed public corpus should ship a prebuilt, pinned index as brief §1.4 describes.
  6. Add a Node conformance test, following `tests/conformance/eslint-tutor.node.test.ts`, that runs `@galaxie/eslint-plugin` over `examples/rag-browser/src/agent/` after type stripping and expects no reports. The host code legitimately uses Workers and IndexedDB, so only the agent folder is linted.
  7. Update the root README examples paragraph, `AGENTS.md` project status, `llms.txt`, the device matrix lanes, and `docs/unsupported.md` limits. In system design, add one line pointing at ADR-0019.
- **Test expectation:** none beyond `pnpm check`, which runs the license, lint, typecheck, test, build, dependency and docs checks.
- **Verification:** `pnpm check` passes from a clean install.

### U8. Retrieval injection test

- **Goal:** show that an injected retrieved passage cannot steer the agent outside its grants.
- **Requirements:** R10.
- **Dependencies:** U5.
- **Files:** `examples/rag-browser/test/injection.test.ts`, `examples/rag-browser/README.md`.
- **Approach:**
  1. The shared prompt-injection corpus already covers the `tool-output` vector with every goal through the real runtime, router and broker, so add no cases to `tests/injection-corpus/cases.json` and change no stated case count.
  2. `injection.test.ts` runs the rag-browser agent with the obedient-attacker mock model. One passage in the top results tells the model to call a URL or reveal a private sentence. It asserts that:
     - the only capability call is `docs.search@1`;
     - no interaction or URL is produced;
     - no request leaves the page.
  3. The README says the shared corpus covers retrieval-shaped data through its `tool-output` vector, and that pasted untrusted text can still mislead a real model into a wrong but well-formed cited answer.
- **Patterns to follow:** `tests/conformance/support/obedient-attacker.ts` and `tests/conformance/injection-corpus.test.ts`.
- **Test scenarios:**
  - An injected passage asking the model to fetch `https://attacker.example/?q=…` produces no request to that host.
  - The rag agent's broker grants list only `docs.search@1`, so an injected instruction to call another capability fails `denied` or `unsupported`.
  - An injected passage asking for an interaction produces no pending interaction.
- **Verification:** the test passes on Node and Chromium, and the shared corpus runner is unchanged.

### U9. Python `galaxie` package and wheels

- **Goal:** the Python proxies, the stand-in, and hash-pinned, self-hosted wheels.
- **Requirements:** R13, R15.
- **Dependencies:** U7.
- **Files:**
  - `python/galaxie/pyproject.toml`
  - `python/galaxie/src/galaxie/__init__.py`, `_bridge.py`, `langchain.py`, `capabilities.py`
  - `python/galaxie/tests/test_bridge.py`, `python/galaxie/tests/test_langchain.py`
  - `python/standins/ormsgpack/pyproject.toml`, `python/standins/ormsgpack/src/ormsgpack/__init__.py`
  - `python/requirements.lock`, `scripts/fetch-python-wheels.ts`, `scripts/build-python-wheels.ts`, `.gitignore`
  - root `package.json`, for the `test:python` script
- **Approach:**
  1. `_bridge.py` sends and awaits `galaxie.bridge/v1` requests through a transport installed at boot. It maps fixed error codes to a `GalaxieError` without content.
  2. `GalaxieChatModel` subclasses LangChain's `BaseChatModel`. It sends the role, the messages in the OpenAI-compatible shape and the options, and returns the checked reply. `capabilities.call(name, input, config)` forwards the call with the effect scope from `langgraph_checkpoint_ns` (ADR-0018 decision 6).
  3. The `ormsgpack` stand-in exposes the functions LangGraph's serializer uses, over `msgpack`, at version 1.13.0, with the license notice of what it replaces.
  4. `requirements.lock` lists every wheel and Pyodide package with version, URL and SHA-256, limited to the KTD13 dependency closure.
  5. The fetch script downloads them into `.cache/python-wheels/` and refuses a mismatch. The build script runs `uv build` for `galaxie` and the stand-in into the same folder.
- **Test scenarios:** run with pytest on CPython through `pnpm test:python`.
  - A fake transport returning a reply makes `GalaxieChatModel.ainvoke` return it as an `AIMessage`.
  - A fake transport returning `{ ok: false, error: { code: 'denied' } }` raises `GalaxieError` with code `denied` and the fixed message.
  - A reply that is not valid bridge JSON raises the fixed `invalid` error.
  - `capabilities.call` sends the name, the input and the effect scope taken from the config.
  - The stand-in round-trips dicts, lists, bytes and nested values identically to `msgpack`.
  - The fetch script rejects a wheel whose bytes do not match the lockfile hash. This is a Node test with an injected fetch.
- **Verification:** `pnpm test:python` passes, and the fetch script fills `.cache/python-wheels/` with every hash matching.

### U10. Pyodide adapter

- **Goal:** `@galaxie/adapter-pyodide`, an `ExecutorAdapter` that runs a LangGraph Python graph in a Worker through the bridge.
- **Requirements:** R12, R13.
- **Dependencies:** U9.
- **Files:**
  - `packages/adapter-pyodide/package.json`, `README.md`, `AGENTS.md`
  - `packages/adapter-pyodide/src/index.ts`, `adapter.ts`, `bridge.ts`, `worker.ts`, `runtime-files.ts`, `errors.ts`
  - `packages/adapter-pyodide/test/bridge.test.ts`, `packages/adapter-pyodide/test/adapter.test.ts`, `packages/adapter-pyodide/test/adapter.node.test.ts`
  - root `package.json`, `scripts/check-dependencies.ts`, `vitest.config.ts`
- **Approach:**
  1. `adapter.ts` implements `prepare` and the run lifecycle with the KTD12 ID, features and cancellation.
     - Model calls follow the KTD12 lease sequence with `RunRequest.models` and the host's `chatModels`, so routing, consent, output safety and usage settle in JavaScript.
     - Capability calls go through `CapabilityPort.call`.
  2. `bridge.ts` holds the message schemas and the size limit, used by both sides.
  3. `worker.ts` is the Worker entry. It boots Pyodide from the host-supplied same-origin base URL, checks the SHA-256 of every locked wheel and package against the lockfile before installing it, then loads the agent module. `runtime-files.ts` lists the expected runtime file names and versions; KTD13 states which bytes the Worker can and cannot bind.
  4. The package's `AGENTS.md` has the sections `check-docs` requires: Purpose, Entry points, Do, Never, Limits, Tests. Limits names the ADR-0018 decision 9 trust limits, the KTD13 runtime-file limit and KTD8's missing features.
  5. Add `check:deps` rules: core never imports this package, and this package imports `@langchain/core` only, never `@langchain/langgraph*` or `@galaxie/adapter-langgraph`.
- **Patterns to follow:**
  - `packages/adapter-langgraph/src/adapter.ts` for the adapter shape, fixed errors and span outcomes.
  - The protocol in `spikes/python-bridge/worker.mjs`. Reimplement it in TypeScript; never copy spike code.
- **Test scenarios:**
  - Bridge: each op's valid message parses, and an unknown op, a missing `v`, the wrong `v`, or a message over 1 MB is rejected with the fixed error.
  - Node, with a real Pyodide and a two-node test graph: a model call reaches the mock model through the router and the checked reply returns to Python.
  - A capability call reaches the broker with its effect scope.
  - Output safety blocking a reply fails the run `denied`, and Python never receives the blocked text. Assert the Worker's received messages.
  - Abort during a model call fails the run `cancelled` and the Worker acknowledges.
  - Abort during a Python busy loop terminates the Worker after 500 ms, and the next run boots a fresh Worker and succeeds.
  - A locked wheel with one wrong byte fails boot with the fixed `unavailable` error and installs nothing.
  - Chromium: the same model and capability round trip works in a real Worker created through the host-supplied `createWorker`.
  - Credential scan: with a provider requiring a credential, no bridge message to the Worker contains the credential. Mirror the AT-23 scan.
- **Verification:** the adapter tests pass on Node and Chromium, and `pnpm check` passes.

### U11. Python RAG agent and executor switch

- **Goal:** the same RAG graph in LangGraph Python, selectable on the page.
- **Requirements:** R12, R14.
- **Dependencies:** U10.
- **Files:** `examples/rag-browser/agent_py/rag_agent/__init__.py`, `examples/rag-browser/agent_py/rag_agent/graph.py`, `examples/rag-browser/agent_py/rag_agent/citations.py`, `examples/rag-browser/agent_py/tests/test_citations.py`, `examples/rag-browser/agent_py/tests/test_lint.py`, `python/galaxie/src/galaxie/lint.py`, `examples/rag-browser/src/agent/definition-python.ts`, `examples/rag-browser/src/host/runtime.ts`, `examples/rag-browser/src/host/app.tsx`, `examples/rag-browser/src/host/trusted-types.ts`, `examples/rag-browser/vite.config.ts`.
- **Approach:**
  1. `graph.py` mirrors `src/agent/graph.ts`: same nodes, state keys, prompt text and citation rules. Only model and capability wiring use the Python `galaxie` proxies.
  2. Prompt text comes from one shared JSON file read by both agents, so the two prompts cannot drift.
  3. `definition-python.ts` reuses the U5 schemas with executor `langgraph-python` and points at the Python module.
  4. The host creates a second instance for the Python agent only when the visitor picks it.
  5. The switch states the download and cold start measured from the KTD13 lock, not the spike's figures, and shows boot progress.
  6. Switch states:
     - the switch is disabled while a run is active;
     - a boot failure shows its fixed message and returns the selection to JavaScript;
     - a build without `.cache/python-wheels/` shows "Python version not included in this build" instead of the option;
     - the selection resets to JavaScript on reload.
  7. The Vite build copies `.cache/python-wheels/` and the agent sources into the output under fixed paths.
  8. A minimal Python lint aid (ADR-0018 decision 9), run by `pnpm test:python`, scans `agent_py/` for `import js`, `pyodide.http`, `urllib`, `socket`, provider SDK imports and provider-prefixed model strings, and fails with a fixed message. Like the ESLint plugin it is a linting aid, not enforcement.
- **Patterns to follow:** `spikes/python-bridge/agent.py` for the LangGraph Python graph shape; rewrite it, don't copy.
- **Test scenarios:**
  - `test_citations.py` runs the same cases as `citations.test.ts`, from one shared JSON case file, with identical results.
  - Loop in mock mode: after switching to Python, a fixture question returns the same answer and citations as the JavaScript agent.
  - Switching back to JavaScript disposes the Python instance and its Worker.
  - Before the switch, no Pyodide file is requested. Assert this with request recording.
  - Loop: a boot failure returns the selection to JavaScript with the fixed message, and the switch is disabled during a run.
  - Each answer shows which executor produced it.
  - `test_lint.py`: a planted `import js` is flagged, and the real `agent_py/` passes.
- **Verification:** the loop tests pass headless with both executors.

### U12. Cross-language parity lane

- **Goal:** prove R14 in CI.
- **Requirements:** R14, R15.
- **Dependencies:** U11.
- **Files:**
  - `examples/rag-browser/test/golden/session.json`, `examples/rag-browser/test/golden/script.json`
  - `examples/rag-browser/test/parity.test.ts`, `examples/rag-browser/test/parity.node.test.ts`
  - `examples/rag-browser/agent_py/tests/test_parity.py`
  - root `package.json` (adding `test:python` to `check`), `.github/workflows/ci.yml`
- **Approach:**
  1. `script.json` fixes the session: questions, modes, the mock search results for each query, and the mock model replies. One recorder writes the KTD15 transcript.
  2. JavaScript runs on Node and Chromium. Python runs through the adapter on Node and Chromium.
  3. CPython runs the graph with a pytest harness that replays `script.json` through a fake transport.
  4. All five transcripts must equal `session.json`, compared as JSON.
  5. CI follows KTD16: set up uv with CPython 3.14, fetch and build wheels, then run the existing steps and `pnpm test:python`.
- **Test scenarios:**
  - All five lanes produce `session.json` exactly.
  - A unit test shows the comparator reports a difference between two transcripts that differ in one model reply.
- **Verification:** the parity lane passes locally and in CI.

### U13. Stage 2 docs and evidence

- **Goal:** record what stage 2 proved and what it did not.
- **Requirements:** R12–R14.
- **Dependencies:** U12.
- **Files:** `docs/adr/0018-python-agents-through-pyodide.md` (Verification section and Revisions line only), `examples/rag-browser/README.md`, `packages/adapter-pyodide/README.md`, `AGENTS.md`, `llms.txt`, `docs/unsupported.md`, `docs/device-matrix.md`, `README.md`.
- **Approach:**
  1. In ADR-0018 Verification, record:
     - the parity lane and its five transcripts;
     - the measured Python cold start and download on the reference device;
     - the KTD8 narrowing.
     State that the adapter turns off all five executor features, so decision 7 (checkpoints through the byte-record port) and the executor-aware `RecoverySession` remain unevidenced. Keep ADR-0018 Proposed: its success criteria include the tutor port.
  2. List the unsupported Python features in `docs/unsupported.md`: interrupts, checkpoints, streaming, pydantic-ai and DSPy. Add the new lanes to the device matrix.
- **Test expectation:** none, documentation only. `check:docs` covers the links.
- **Verification:** `pnpm check` passes. ADR-0018 still reads Proposed, with the new evidence dated 2026-10-30 or later.

---

## Verification Contract

| Gate | Command or step | When |
|---|---|---|
| Full repo check | `pnpm check` | before each pull request, and after U7 and U12 |
| Python lane | `pnpm test:python` | U9–U12; also part of `pnpm check` from U12 |
| Wheel fetch | the U9 fetch script, before tests | stage 2, locally and in CI |
| Corpus build | `pnpm --filter @galaxie/example-rag-browser corpus` | once by hand; never in CI |
| Real device | default mode on the Apple M5 Pro with Chrome: consent, full index, three questions in each mode, evaluation, paste, reload, clear, Python switch | after U6 and after U11; record figures in the README as demonstrations |

Format with `pnpm format`. Tests use mocks and the committed fixture only (R15).

---

## Definition of Done

- Every unit's Verification holds, and `pnpm check` passes from a clean install with the CI workflow's steps.
- Stage 1 and stage 2 are separate pull requests against `main`, and neither is merged by the implementer.
- The README states the measured figures as demonstrations on one device and names the unmeasured items.
- No spike code is copied into `packages/` or `examples/`. Every new source file has the SPDX header, and every new `package.json` has `"license": "AGPL-3.0-only"`.
- No document calls galaxie secure, compliant or suitable for regulated use.
- No abandoned-attempt code, debug logging or unused dependency remains in the diff.
- `pnpm-lock.yaml` changes only through the new dependencies, pinned to exact versions that pass the 7-day release-age gate.

---

## Risks

| Risk | Effect | Mitigation |
|---|---|---|
| Transformers.js 4.3.1 hangs on failed downloads | indexing never finishes | KTD3 own fetch with fixed errors; upgrade to 4.3.2 later |
| Two WebGPU models at once on one device | device loss or slow indexing | Assumption recorded; index before preparing chat models; README limit |
| First load holds the 174 MB weights about twice (issue #1827) | memory pressure on small devices | Desktop reference only; README limit |
| A LangGraph Python dependency lacks a Pyodide wheel | stage 2 blocked | Stop condition; stage 1 ships alone |
| Prompt or citation rules drift between languages | parity lane fails | Shared prompt JSON and shared citation cases (U11) |
| SQuAD source URL moves | corpus script fails | Pinned SHA-256 gives a clear failure; the script accepts a different URL with the same hash |
