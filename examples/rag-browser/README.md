# Browser-built RAG

This maintained example builds a retrieval index on the visitor's device, searches it through `docs.search@1`, and answers through the routed `rag.answer` model. The visitor can choose LangGraph.js, LangGraph Python, pydantic-ai Python or DSPy Python. The pydantic-ai choice currently uses mock models only. A retrieval Worker owns EmbeddingGemma 2 and Orama; the page owns the runtime, broker and model router. Each selected Python agent runs in a separate Pyodide Worker. No server embeds, searches or generates.

From the repository root:

```sh
pnpm install
pnpm --filter @galaxie-ai/example-rag-browser corpus
pnpm --filter @galaxie-ai/example-rag-browser dev
```

The corpus command is an explicit network operation, never part of tests or CI. It verifies the official SQuAD v1.1 validation source at `https://rajpurkar.github.io/SQuAD-explorer/dataset/dev-v1.1.json`: 4,854,279 bytes, SHA-256 `95aa6a52d5d6a735563366753ca50492a658031da74f301ac5238b03966972c9`. An optional URL argument may supply the same bytes from another location. It writes the git-ignored `public/data/squad-dev.json`, deduplicating contexts in source order while preserving question and answer order. The reviewed source inventory is 48 articles, 2,067 distinct contexts and 10,570 questions. Corpus generation was not run during this implementation. Without this file, the page explains the command and still supports pasted text after embedding preparation.

For a download-free demonstration with the committed, original synthetic fixture:

```sh
pnpm --filter @galaxie-ai/example-rag-browser dev:mock
```

Mock mode indexes 12 synthetic passages on load and uses deterministic embeddings and chat replies. Try “capital of France”, then paste a paragraph and ask about it. Mock chat replies quote the first retrieved passage; pydantic-ai review and DSPy quote the supplied kept passages. These replies do not measure answer quality.

## Hosted demo build

The [demo workflow](../../.github/workflows/demo.yml) builds mock mode with
`VITE_GALAXIE_DEMO=1` and uploads `examples/rag-browser/dist` as the `demo-dist`
artifact for 14 days. It builds the same Python assets as `dev:mock`. A push to
`main` also builds a second copy with `GALAXIE_DEMO_BASE=/<repository>/` and
deploys it to GitHub Pages at `https://vinhnxv.github.io/galaxie/`. That variable
sets the Vite `base` and the runtime asset paths; unset, the build keeps root
paths. This artifact uses mock models and the synthetic corpus only. Real
models need a local default-mode build, without the demo flag.

The demo flag initially checks **Review passages before answering**; visitors can
uncheck it. A fixed cue explains that reloading a paused review resumes it and
**Start over** clears it. After reload, click **Prepare models** again to restore
the pending review; a status line confirms restoration. Review selections reset
on reload, and the existing device-storage and browser-eviction limits still apply.
Without the flag, mock builds retain the usual unchecked review default and text.

Mock builds put the CSP meta element first in the built page's `<head>`, before
scripts and styles, so the page enforces its policy without a response header.
The policy derives from the existing directives and omits `frame-ancestors`,
which browsers ignore in a meta policy. The same build writes `dist/_headers` in
Netlify / Cloudflare Pages format: a `/*` rule with the full
`Content-Security-Policy` header, including `frame-ancestors 'none'`. Header-capable
hosts should serve that full policy. Dev and preview keep their existing headers;
default-mode build output is unchanged.

Hosts that cannot send headers, such as GitHub Pages, use only the meta policy
and have no `frame-ancestors` protection. This is a recorded limit of this
mock-only demo, accepted by the maintainer on 2026-11-14 (GitHub Pages, no
credentials or model data in the build). A header-capable host can serve
`dist/_headers` to restore it.
The meta policy does not provide response headers for Worker scripts; this
artifact demonstrates the same-origin mock flow, not default-mode model loading.
The deployed site is a mock-only demonstration with no device or model measurements.

Build locally from the repository root after installing dependencies (build the
[Python wheel cache](#optional-python-build) first to include Python):

```sh
VITE_GALAXIE_DEMO=1 pnpm --filter @galaxie-ai/example-rag-browser exec vite build --mode mock
pnpm --filter @galaxie-ai/example-rag-browser exec vite preview --mode mock --host 127.0.0.1
```

A build without the wheel cache still runs the JavaScript demo. Preview supplies
the full CSP header; the demo build test instead uses a plain static server with
no CSP response header to check meta enforcement and paused-review reload.

### Passage review with mock models

With the existing local Python wheel cache built, `dev:mock` builds and serves all four executors at **http://127.0.0.1:4173/**. It uses the committed synthetic corpus and mock models, makes no model download, and retains the strict CSP and Trusted Types policy. It is a build-and-preview command; restart it after source edits. The plain Vite `dev` command still omits Python.

1. Open that URL and wait for **Ready: 12 passages**. Click **Prepare models**.
2. Choose **LangGraph.js** in **Agent executor**. Check **Review passages before answering**, enter **capital**, choose **Full-text**, and click **Ask**.
3. The retrieval subgraph runs, then **Review retrieved passages** lists IDs and titles only. Uncheck **Cities (p1)** and **Cities (p3)** to keep Portugal's passage, **Cities (p2)**. Click **Answer with kept passages**. Watch the checked answer text stream, then see the Lisbon citation. **Retrieval subgraph streamed.** confirms a nested stream path was observed. Mock chunks are paced so the stream can be seen by hand.
4. Click **Start over**, select **LangGraph Python**, and repeat steps 2–3. Then repeat with **pydantic-ai Python** and **DSPy Python**. Python boots only after selection; each review uses a separate durable instance. DSPy retrieves and pauses directly in its async module before the first model call, then streams a `ChainOfThought` answer with no subgraph notice. In pydantic-ai, a deferred `review_passages` tool approval replaces the retrieval subgraph, so the subgraph notice is absent. To keep two passages, uncheck only **Cities (p1)**.
5. On any executor, start another review and reload while **Run: waiting_input** is shown. Click **Prepare models** again. The host restores the saved executor and pending review from reopened IndexedDB. Selections reset to all passages; choose the passages again and submit to finish the answer.
6. **Start over** disposes the review and deletes its checkpoints, writes and recovery records. Reload, prepare models, leave review unchecked, and ask again: this uses the default in-memory JavaScript instance. To use an in-memory Python instance instead, select its executor first.

Only review sessions use `IndexedDBSaver` and its recovery store, scoped to app `rag-browser` and the demo principal `visitor`. A local-storage reference contains only `{ executor, sessionId }`; checkpoint contents remain in IndexedDB. Web Lock ownership and transaction fencing protect writes. An evicted or expired saved review shows a fixed restoration error and offers Start over, which also removes its stale reference. A second tab offers **Use here**; the former owner disposes its runtime and requires reload. Reviews contain personal question and passage data and have the saver's default retention (7-day history, 30-day inactivity), swept when opening a review. Start over explicitly deletes the current review. Browser eviction can remove it. Completed answer display and unsent selections do not restore. This is a single demo visitor, not authenticated multi-user storage.

Automated tests cover the existing LangGraph review parity and subgraph paths. The pydantic-ai agent has CPython and Node Pyodide tests for retrieval, citations, deferred review and resume validation; Node Pyodide also covers nameless prompted-output retries. Real headless Chromium page tests cover its checked answer stream, selected-executor download bytes, reload, resume with kept citations, Start over deletion, switching across all four executors and the injected-passage output block. DSPy has separate CPython and Node Pyodide coverage for input-owned retrieval, citations, review before any model call and invalid kept-ID rejection. The same Chromium page tests cover its reload/resume, deletion, all-executor switching, bytes and canary. A mock-only hands-on Chrome check of DSPy (2026-10-31) covered a cited answer, review with two kept passages, reload restore of the executor and pending review, resume and Start over. These fixtures make no claim about real-model robustness. Hands-on check, 2026-10-31, Google Chrome on macOS, `dev:mock`, mock models only: selecting pydantic-ai Python answered with one citation; review mode paused with IDs and titles of four passages; a reload during **Run: waiting_input** followed by **Prepare models** restored the pydantic-ai executor and the same pending review; keeping only **Cities (p2)** produced a succeeded run citing only that passage; **Start over** returned the run to idle. The console showed no errors. No real model, download or device measurement was part of this check. Hands-on check, 2026-10-30, Google Chrome 156 on macOS, `dev:mock`, mock models only: on LangGraph Python, review mode paused with three passages and showed **Retrieval subgraph streamed.**; a reload during **Run: waiting_input** followed by **Prepare models** restored the Python executor and the same pending review; keeping only **Cities (p2)** produced a succeeded run citing only that passage, and the answer text grew through twelve visible partial states before the citation appeared. The same review flow on LangGraph.js produced the same answer. **Start over** cleared each review. The console showed no errors. No real model, download or device measurement was part of this check.

## Optional Python build

Python is included in built pages served through `preview`; the Vite development server omits the Python option because its static runtime inventory is emitted at build time. Install uv with CPython 3.14, then run these commands from the repository root:

```sh
uv sync --project python --locked
node scripts/fetch-python-wheels.ts
node scripts/build-python-wheels.ts
pnpm test:python
pnpm --filter @galaxie-ai/example-rag-browser build
pnpm --filter @galaxie-ai/example-rag-browser preview
```

For the synthetic Python demonstration, use `build --mode mock` followed by `preview --mode mock` instead. It needs no model or corpus download.

Sync and the explicit wheel-fetch script are setup operations that can use the network. The fetch script verifies the byte size and SHA-256 of every file in `python/requirements.lock`; tests never fetch packages. The build script runs offline and writes the local `galaxie` and limited `ormsgpack` stand-in wheels to the ignored `.cache/python-wheels/` directory. Rebuild those wheels after changing their Python sources. Both locks use the same resolved graph dependency versions under the seven-day release cutoff, with no package-specific age exceptions.

A build without that cache displays **Python version not included in this build**. JavaScript remains usable. In builds with Python, the **Agent executor** radio group becomes available after indexing and chat preparation. It states each offered Python executor's additional download before selection; each executor installs only its own wheel set. The pydantic-ai option appears only when the answer role has a provider declaring `tool-calling`. Mock mode declares it; the bundled WebLLM and Built-in AI providers do not, so default mode omits this choice. DSPy appears whenever the answer role has a configured provider; it needs streaming but no tool calling. Default mode can offer DSPy, while real-model ChatAdapter format reliability remains unmeasured. Python starts only when selected or when preparing a saved Python review. **Cancel Python boot** returns to JavaScript for the default flow. Boot failures show fixed text and return focus to the JavaScript choice. Switching disposes the default Python instance while retaining the prepared chat models; Clear data and page exit dispose the runtime and models. Each answer retains the name of the executor that produced it. Reload starts with JavaScript selected unless model preparation restores a pending review.

The Python package proxies model and capability calls over `galaxie.bridge/v2` JSON, limited to 1,048,576 UTF-8 bytes. Routing, consent, labels, budgets, credentials, output checks and capability authorization stay in JavaScript. No credential reaches Python. Abort asks the Worker to settle; after 500 ms without acknowledgment the adapter terminates it, and the next run creates a fresh Worker. Core still owns run settlement.

LangGraph Python keeps all five features: interrupts, resume, durable checkpoints, streaming and subgraphs. Its graph compiles with `galaxie.langgraph.checkpointer()`. pydantic-ai Python declares the first four true and `subgraphs: false`. It uses `GalaxieModel("rag.answer")`, a capability-backed `search_docs` tool and text output with the shared citation projection. Its `review_passages` tool raises `ApprovalRequired` with broker-returned passages in deferred metadata; the interaction exposes only their IDs and titles. The existing `submit` action supplies kept IDs, checked against those passages before approval. Restored history rebuilds citations without accepting passage text from model arguments.

DSPy Python also declares streaming, interrupts, resume and checkpoints true, with subgraphs false. Its async module calls `docs.search@1` once with the run input's question and mode and `k: 10`. Optional review uses `galaxie.dspy.request_interaction` before any model request; only the kept passages reach `ChainOfThought` through `GalaxieLM("rag.answer")`. The `question, passages -> answer` signature declares `answer: str` and `stream_fields=["answer"]`. The shared citation projection returns only `{ answer, citations, sources }`.

DSPy resume reruns deterministic author code against completed-call journals. Calls replay silently until the frontier; different request digests fail `unrecoverable` before later live calls. Review journals persist in scoped byte records with recovery and fencing. Restored input and results re-register private strings through core's framework-neutral `registerRestoredData` hook before validation or live calls. The journal must fit the 1 MiB bridge limit including base64 before pausing; completion keeps compact counters. Calls after the last committed pause may run again after Worker loss; broker write receipts require recovery and stable order.

An `Executor` with `stream_fields` always streams and requires a streaming provider. Fields must identify one predictor's plain-`str` output; streaming ReActV2 needs `next_thought` annotated as `str`. Indented field headers are not streamed, though final parsing still returns the field. JSONAdapter streaming and ChatAdapter JSON fallback are unsupported. ReAct turns ordinary author tool exceptions into observations with a five-frame traceback (paths/source lines) sent on the next routed model call; galaxie failures instead terminate with fixed codes before that call. This RAG program uses no ReAct tools. See the [DSPy limits](../../packages/adapter-pyodide/README.md#dspy-programs), including omitted provider/cache dependencies and CPython's metadata-only `litellm==1.106.2` stand-in.

Default questions stay in memory and restore no question or answer after reload. Cancellation or Worker loss discards in-memory Python state and makes pending/resume fail `unavailable`. Opt-in review instances supply scoped durable checkpoints and executor-aware recovery. Python streams carry bounded JSON projections and checked model deltas. The page renders only LangGraph answer-node text, pydantic-ai checked text or DSPy checked answer-field text, plus final `{ answer, citations }`, as React text; graph state and tool arguments/results are not display data. The tutor port remains separate work. The display resets streamed answer text at each new model call, and the header subtitle names the selected executor.

Python code is trusted and can import `js`; a Worker does not isolate an unreviewed agent. The Python AST lint aid flags direct browser/network/provider access but is advisory. The Pyodide Worker keeps `connect-src 'self'` even when the default page permits model-download hosts. Its `importScripts` shim throws `TypeError` before Pyodide's classic-worker probe reaches a Trusted Types sink, without changing CSP. Third-party wheel hashes are compiled into the Worker and verified before installation. Local wheels, agent sources and self-hosted Pyodide runtime files share the page build's trust; runtime loader/WASM/stdlib bytes are not independently bound by the adapter. A CDN deployment needs SRI or pinned hashes and is not implemented here.

## Default mode and consent

The embedding button states **233.6 MB** before any model request: 206,696,682 bytes of model files plus 26,914,834 bytes of bundled ONNX Runtime assets (233,611,516 bytes total, before HTTP compression). The five files use the reviewed SHA-256 inventory at EmbeddingGemma revision `daa72c51243991dfcaf9f9137d2c573d8f7790c0`. The Worker downloads and verifies them itself. Transformers.js 4.3.1 reads only that cache, with its fetch hook denied, to avoid the library's failed-download hang. ONNX Runtime's Asyncify `.mjs` and `.wasm` are served same-origin. WebGPU is required; there is no WASM inference fallback. A failed download needs another intentional button click.

Build the index before pressing **Prepare models**. That click follows host-local's Built-in AI and WebLLM preparation pattern. Chrome manages the Built-in AI download and does not report its size. WebLLM's pinned Qwen2.5 1.5B weights are 868,547,584 bytes, plus the model library and tokenizer. These chat downloads are separate from embedding consent. All generation routes stay `in-browser`; a dispatched call never falls back after failure. The output-safety hook blocks only the fixed `GALAXIE_BLOCK_DEMO` marker and is a seam demonstration, not a content filter.

The Worker truncates passages to 256 tokens in batches of eight, cuts embeddings to 256 dimensions, and normalizes them. Queries use `task: search result | query: `; documents use `title: <title> | text: <text>`, with `title: none` for pasted passages. The tokenizer retains Unicode letters and numbers and lowercases without stemming. Hybrid weights are 0.5/0.5. The explicit vector similarity threshold is **0.2**: with the synthetic fixture and mock embedder, “capital of France” scores the relevant passage at 0.408248 and unrelated passages at no more than 0.166667. This is fixture evidence; real-model threshold quality remains unmeasured.

## Data and trust boundaries

The only capability is the bounded `in-browser` read `docs.search@1`. The pydantic-ai agent runs it exactly once with the input's question and mode and `k: 10`; any other model-chosen arguments or a second search fail `invalid`. In review mode its search result gives the model passage IDs and titles only, and the answer turn receives the text of kept passages only. Queries and all returned passage text are labeled `private-user`, including public corpus results, because one index can also contain pasted text. Results contain at most ten passages, each with at most 4,000 characters. Review props and action payloads also carry `private-user`; props expose only passage IDs and titles, without URLs or passage text. The DSPy program never lets a model choose search arguments or add an interaction. It pauses before its first model call, so unchecked passage text never reaches a model request before review returns the kept passages. The LangGraph agents treat kept passages as delimited JSON reference data and ignore model tool calls. The pydantic-ai agent uses only its declared retrieval and review tools; broker grants and JavaScript checks still apply. The host renders each agent's checked answer message text and final `{ answer, citations, sources }` projection as React text. Citation markers outside the kept range are removed; duplicates become one citation in first-seen order. `sources` lists every passage sent to the model (after review, only the kept ones). When an answer has no valid marker, the page shows these as **Passages sent to the model** with a note that the answer may draw on any of them; it never assigns sentences to passages, because small in-browser models often omit or misplace markers. Native diagnostic stream events can still contain working state; hosts must never render them as display data. The LangGraph example uses native `outputKeys` to project final stream values, without changing the adapter; pydantic-ai projects its final cited text through `Executor`.

The separate IndexedDB database `galaxie-rag:<encoded-appId>:<encoded-principalScope>` holds the saved Orama index and pasted passages for one app and principal. Each component uses `encodeURIComponent`, so a colon inside either component cannot collide with the separator. The same name scopes its Web Lock, BroadcastChannel and epoch entry. The host defines its constant `visitor` principal once in `src/host/scope.ts` and passes it through the validated retrieval init protocol. A SHA-256 fingerprint covers the exact corpus file bytes, model revision, embedding settings, library versions, tokenizer, schema version and mock/real mode. A mismatch discards the record and rebuilds, including discarding old pasted passages. Orama `save`/`load` preserve vectors and our schema/tokenizer; no persistence plugin is used.

Retry indexing reloads the page to create a fresh retrieval Worker. A persisted history return also reloads, restoring the saved index and requiring chat preparation again. Unsaved drafts and answers reset on either path. Tests exercise the persisted lifecycle events; real bfcache navigation remains unmeasured.

Writes and clear share a Web Lock. Clear bumps this scope's epoch, deletes its content database and broadcasts cache invalidation to its other tabs and Workers. A separate content-free epoch database, `galaxie-rag:epochs`, fences stale writers even before another Worker receives the notice. Only generation counters remain there, keyed by the scoped cache name. The retrieval service imports `watchInvalidation` from `@galaxie-ai/core/browser` and watches `watchInvalidation({ appId, principalScope })` directly in the retrieval Worker: BroadcastChannel and AbortSignal work there, and the service already owns the cache and in-memory index, so no forwarding protocol is needed. A matching principal-invalidation notice runs the same clear operation, dropping the in-memory index and pasted passages and resetting the snapshot. Notices for another app or principal do nothing. Core's signal is one-shot; the service closes it and opens a fresh watcher after each wipe, and closes the watcher on reinitialization or disposal (Worker termination also releases it). Missing BroadcastChannel or Web Locks uses the cache-unavailable failure path. **Clear data** waits for its local retrieval wipe, then uses a temporary core watcher to announce the same principal invalidation to peers and closes it. Core also aborts the announcer's signal; the temporary host watcher has no cleanup listener. Clear data also clears this page's drafts and answer and disposes its chat runtime. It keeps downloaded model files. **Remove downloaded model** removes the embedding model Cache Storage; it does not remove WebLLM or browser-managed chat downloads.

The retrieval cache remains outside `@galaxie-ai/storage-indexeddb`, but is scoped by app and principal and wiped by the principal-invalidation signal and Clear data. It has no retention sweep. This example has no login or host-side principal logout wipe: every visitor uses the constant `visitor` principal. A real host must derive its principal from the authenticated session, commit its principal wipe, then announce core's invalidation; this example does not demonstrate end-to-end logout. Pasted text persists until either wipe trigger or browser eviction; there is no individual-passage removal. A cache database left by an earlier build, which was named by app only, is neither restored nor migrated; Clear data deletes it. Use one tab at a time when building: concurrent builds replace whole records and can duplicate work or replace one another's additions. Clear is coordinated across tabs. Each question is one run. The retrieval index and pending review sessions restore after reload; default questions and answer displays do not. Browser eviction can lose both databases.

The shared [prompt-injection corpus](../../tests/injection-corpus/README.md) covers retrieval-shaped data through its `tool-output` vector. This example additionally runs the obedient-attacker mock through the real runtime, router and broker. Its LangGraph URL/tool/interaction directives produce no outbound request or pending interaction. The fixed graphs ignore those directives before any capability dispatch; an unlisted run grant is rejected as `invalid`. The pydantic-ai fixtures reject an unoffered tool or unrequested review, and the pydantic-ai and DSPy Chromium pasted-passage cases prove the demonstration output hook blocks the fixed canary without adding an interaction or request. Pasted untrusted text can still mislead a real model into a wrong but well-formed cited answer. Plain-text URLs can appear in model prose; the host does not turn them into links. Trusted bundled code and same-origin dependencies remain outside these containment claims.

## Verification and demonstrations

`pnpm check` includes both TypeScript compiler lanes, Node and headless Chromium tests, the offline CPython 3.14 lane, builds, agent lint, dependency boundaries and document checks. Tests use mocks, injected fetch, fake model engines and the committed fixture. Browser loops cover strict CSP/Trusted Types, real module Workers and IndexedDB, all search modes, answers, paste, restore, cross-Worker clear fencing, keyboard controls and narrow layouts. Python coverage adds verified wheel installation and framework imports under that CSP, lazy selection, boot cancellation/failure, disposal, credential isolation, checked output, cooperative abort and busy-loop termination. No corpus or real model download was performed for this implementation.

The shared prompt JSON, prompt cases and ASCII citation-marker cases keep the two LangGraph agents aligned. The parity fixture records capability inputs, normalized model messages and final output across JavaScript on Node/Chromium, Python in Pyodide on Node/Chromium and native CPython. All five lanes match the committed golden. It includes all search modes, no passages and non-ASCII text with quotes, a backslash and a newline. Its search results are checked against the actual mock-embedded fixture index. The pydantic-ai RAG agent has separate tool-driven tests and DSPy has separate program-driven tests; it does not replace or rewrite that LangGraph transcript. These deterministic transcripts assess execution behavior, not model robustness or answer quality.

The evaluation button samples up to 200 validation questions with a fixed seed. It searches each mode with `k = 10`, filtering to corpus passages, without invoking a model. Recall@1/5/10 and MRR include misses as zero and display the sample size. These figures are demonstrations, never gates.

| Reference-device demonstration | Result |
| --- | --- |
| Full SQuAD conversion and indexing | Not run; source counts above come from the reviewed pins |
| Cold index time and saved index size | Unmeasured |
| Full-text, vector and hybrid per-query latency | Unmeasured |
| Actual embedding/chat download bytes and time | Unmeasured; declared file totals above |
| Validation recall@1/5/10 and MRR with EmbeddingGemma | Unmeasured |
| Real-model citation frequency and correctness | Unmeasured; one DSPy observation is recorded below |
| Reference-device Python download and cold start | Unmeasured; local synthetic test-lane observations are recorded separately below |

No Apple M5 Pro/Chrome real-model demonstration is claimed here. Two WebGPU models on one device, memory pressure (including initial weight-buffer duplication), device-loss behavior and the cost of foregoing model cache reuse remain unmeasured. WebLLM's 4,096-token context can reject large retrieved prompts; the passage character cap is not a token guarantee. The README reports no answer-quality score or performance threshold. A fixed public corpus in a host application should normally ship as a prebuilt, pinned index, as [brief §1.4](../../docs/galaxie-project-brief.md#14-example-deployments-vision) describes; this example builds in the browser to demonstrate indexing arbitrary text.

### DSPy real-model observation

On 2026-10-31 a hands-on Chrome check ran DSPy Python with Chrome Built-in AI as the answer provider over five pasted passages. Before the `answer` output field described the `[n]` marker requirement, the model returned a correct but uncited `1994` both with and without review, while LangGraph.js cited the supporting passage for the same question. With that field description, two questions produced answers whose markers cited the matching passages. A temporary local build that preferred WebLLM (Qwen2.5 1.5B) asked the same two questions with the field description: DSPy answered the first without a marker and cited all five passages, relevant or not, for the second. LangGraph.js on WebLLM answered the second without a marker and cited an unrelated passage for the first, so marker reliability on that model is weak for both executors. These are single local observations, not citation-rate measurements.

### Local Python observations

Earlier-build observations on 2026-10-30 in the local synthetic test lanes, with Pyodide 314.0.7 and mock inference. These historical totals predate passage review; the page computes and discloses the current build total before Python selection:

| Observation | Result |
| --- | ---: |
| Fresh-Worker agent-ready time, Node 24.15.0 | About 2.83 s |
| Fresh-Worker agent-ready time, headless Chromium 156.0.8078.4 | About 2.85 s |
| Self-hosted runtime files | 13,412,130 bytes |
| 37 hash-pinned third-party wheels | 6,042,342 bytes |
| Built `galaxie` and `ormsgpack` wheels | 7,637 bytes |
| Agent Python/JSON sources | 4,204 bytes |
| Product Python Worker bundle | 20,075 bytes |
| Additional product Python download disclosed before selection | 19,486,388 bytes |
| Node loopback response bodies; runtime files load from disk | 6,054,183 bytes |

Host-loop tests verify that each Python executor's displayed download total equals the sum of its actual response bodies. The LangGraph third-party wheel inventory stays unchanged; shared wheel and Worker code may grow. The separate Chromium parity harness adds a 137-byte CSP-reporting wrapper, giving 19,486,525 response-body bytes in that lane. These byte totals omit HTTP headers, framing and compression. They describe that earlier build; source changes alter the computed total.

The 2026-10-31 DSPy build discloses **17,928,157 additional response-body bytes** for the self-hosted runtime, selected wheels, agent files and Worker bundle. Its 23 hash-pinned third-party wheels total 4,431,463 bytes; including the two shared local wheels gives 4,462,155 wheel bytes. The Chromium host-loop assertion compares served bodies with the build's selected-executor total. These are file-body counts before compression, with mock inference and no real-model download or latency measurement.

Timing starts with a fresh Worker and ends after interpreter boot, wheel size/hash verification and installation, framework imports and graph construction. Runtime assets were already installed; local OS caches may have been warm. These are single local observations, with no download-latency distribution or reference-device performance claim. GitHub CI execution and reference-device Python startup/download remain unmeasured.

## Licenses

SQuAD v1.1: Rajpurkar et al. (2016), [SQuAD](https://rajpurkar.github.io/SQuAD-explorer/), [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). The derived corpus and page carry this notice. The committed fixture is original synthetic text and copies no SQuAD passage. EmbeddingGemma 2, Orama and Transformers.js are Apache-2.0; ONNX Runtime is MIT. Example source is Apache-2.0. [ADR-0019](../../docs/adr/0019-in-browser-retrieval.md) records the browser-built retrieval decision and its limits.
