# Browser-built RAG

This maintained JavaScript example builds a retrieval index on the visitor's device, searches it through `docs.search@1`, and answers through the routed `rag.answer` model. A retrieval Worker owns EmbeddingGemma 2 and Orama; the page owns the runtime, broker and model router. No server embeds, searches or generates. The Python executor is follow-up work and is not included in this build.

From the repository root:

```sh
pnpm install
pnpm --filter @galaxie/example-rag-browser corpus
pnpm --filter @galaxie/example-rag-browser dev
```

The corpus command is an explicit network operation, never part of tests or CI. It verifies the official SQuAD v1.1 validation source at `https://rajpurkar.github.io/SQuAD-explorer/dataset/dev-v1.1.json`: 4,854,279 bytes, SHA-256 `95aa6a52d5d6a735563366753ca50492a658031da74f301ac5238b03966972c9`. An optional URL argument may supply the same bytes from another location. It writes the git-ignored `public/data/squad-dev.json`, deduplicating contexts in source order while preserving question and answer order. The reviewed source inventory is 48 articles, 2,067 distinct contexts and 10,570 questions. Corpus generation was not run during this implementation. Without this file, the page explains the command and still supports pasted text after embedding preparation.

For a download-free demonstration with the committed, original synthetic fixture:

```sh
pnpm --filter @galaxie/example-rag-browser dev --mode mock
```

Mock mode indexes 12 synthetic passages on load and uses deterministic embeddings and chat replies. Try “capital of France”, then paste a paragraph and ask about it. Mock chat replies quote the first retrieved passage; they do not measure answer quality.

## Default mode and consent

The embedding button states **233.6 MB** before any model request: 206,696,682 bytes of model files plus 26,914,834 bytes of bundled ONNX Runtime assets (233,611,516 bytes total, before HTTP compression). The five files use the reviewed SHA-256 inventory at EmbeddingGemma revision `daa72c51243991dfcaf9f9137d2c573d8f7790c0`. The Worker downloads and verifies them itself. Transformers.js 4.3.1 reads only that cache, with its fetch hook denied, to avoid the library's failed-download hang. ONNX Runtime's Asyncify `.mjs` and `.wasm` are served same-origin. WebGPU is required; there is no WASM inference fallback. A failed download needs another intentional button click.

Build the index before pressing **Prepare models**. That click follows host-local's Built-in AI and WebLLM preparation pattern. Chrome manages the Built-in AI download and does not report its size. WebLLM's pinned Qwen2.5 1.5B weights are 868,547,584 bytes, plus the model library and tokenizer. These chat downloads are separate from embedding consent. All generation routes stay `in-browser`; a dispatched call never falls back after failure. The output-safety hook blocks only the fixed `GALAXIE_BLOCK_DEMO` marker and is a seam demonstration, not a content filter.

The Worker truncates passages to 256 tokens in batches of eight, cuts embeddings to 256 dimensions, and normalizes them. Queries use `task: search result | query: `; documents use `title: <title> | text: <text>`, with `title: none` for pasted passages. The tokenizer retains Unicode letters and numbers and lowercases without stemming. Hybrid weights are 0.5/0.5. The explicit vector similarity threshold is **0.2**: with the synthetic fixture and mock embedder, “capital of France” scores the relevant passage at 0.408248 and unrelated passages at no more than 0.166667. This is fixture evidence; real-model threshold quality remains unmeasured.

## Data and trust boundaries

The only capability is the bounded `in-browser` read `docs.search@1`. Queries and all returned passage text are labeled `private-user`, including public corpus results, because one index can also contain pasted text. Results contain at most ten passages, each with at most 4,000 characters. The graph treats passages as delimited JSON reference data. It ignores model tool calls and renders only its final `{ answer, citations }` projection as React text. Citation markers outside the retrieved range are removed; duplicates become one citation in first-seen order. Native diagnostic stream events can still contain working state; hosts must never render them as display data. The example uses native `outputKeys` to project final stream values, without changing the adapter.

The separate IndexedDB database `galaxie-rag:rag-browser` holds the saved Orama index and pasted passages. A SHA-256 fingerprint covers the exact corpus file bytes, model revision, embedding settings, library versions, tokenizer, schema version and mock/real mode. A mismatch discards the record and rebuilds, including discarding old pasted passages. Orama `save`/`load` preserve vectors and our schema/tokenizer; no persistence plugin is used.

Retry indexing reloads the page to create a fresh retrieval Worker. A persisted history return also reloads, restoring the saved index and requiring chat preparation again. Unsaved drafts and answers reset on either path. Tests exercise the persisted lifecycle events; real bfcache navigation remains unmeasured.

Writes and clear share a Web Lock. Clear deletes the content database and broadcasts invalidation. A separate content-free epoch database, `galaxie-rag:epochs`, fences stale writers even before another Worker receives the notice. Only generation counters remain there. **Clear data** also clears this page's drafts and answer and disposes its chat runtime. It keeps downloaded model files. **Remove downloaded model** removes the embedding model Cache Storage; it does not remove WebLLM or browser-managed chat downloads.

The retrieval cache is outside `@galaxie/storage-indexeddb`: its retention sweep, principal scoping and logout wipe do not apply. Pasted text persists until clear or browser eviction; there is no individual-passage removal. Use one tab at a time when building: concurrent builds replace whole records and can duplicate work or replace one another's additions. Clear is coordinated across tabs. Each question is one run with an in-memory checkpointer. Questions, answers and executor sessions do not restore after reload; the retrieval index does. Browser eviction loses that index.

The shared [prompt-injection corpus](../../tests/injection-corpus/README.md) covers retrieval-shaped data through its `tool-output` vector. This example additionally runs the obedient-attacker mock through the real runtime, router and broker. Its URL/tool/interaction directives produce no outbound request or pending interaction. The fixed graph ignores those directives before any capability dispatch; an unlisted run grant is rejected as `invalid`. Pasted untrusted text can still mislead a real model into a wrong but well-formed cited answer. Plain-text URLs can appear in model prose; the host does not turn them into links. Trusted bundled code and same-origin dependencies remain outside these containment claims.

## Verification and demonstrations

`pnpm check` includes both TypeScript compiler lanes, Node and headless Chromium tests, builds, agent lint, dependency boundaries and document checks. Tests use mocks, injected fetch, fake model engines and the committed fixture. Browser loops cover strict CSP/Trusted Types, real module Workers and IndexedDB, all search modes, answers, paste, restore, cross-Worker clear fencing, keyboard controls and narrow layouts. No corpus or real model download was performed for this implementation.

The evaluation button samples up to 200 validation questions with a fixed seed. It searches each mode with `k = 10`, filtering to corpus passages, without invoking a model. Recall@1/5/10 and MRR include misses as zero and display the sample size. These figures are demonstrations, never gates.

| Reference-device demonstration | Result |
| --- | --- |
| Full SQuAD conversion and indexing | Not run; source counts above come from the reviewed pins |
| Cold index time and saved index size | Unmeasured |
| Full-text, vector and hybrid per-query latency | Unmeasured |
| Actual embedding/chat download bytes and time | Unmeasured; declared file totals above |
| Validation recall@1/5/10 and MRR with EmbeddingGemma | Unmeasured |
| Real-model citation frequency and correctness | Unmeasured |
| Python download and cold start | Not included in this JavaScript stage |

No Apple M5 Pro/Chrome real-model demonstration is claimed here. Two WebGPU models on one device, memory pressure (including initial weight-buffer duplication), device-loss behavior and the cost of foregoing model cache reuse remain unmeasured. WebLLM's 4,096-token context can reject large retrieved prompts; the passage character cap is not a token guarantee. The README reports no answer-quality score or performance threshold. A fixed public corpus in a host application should normally ship as a prebuilt, pinned index, as [brief §1.4](../../docs/galaxie-project-brief.md#14-example-deployments-vision) describes; this example builds in the browser to demonstrate indexing arbitrary text.

## Licenses

SQuAD v1.1: Rajpurkar et al. (2016), [SQuAD](https://rajpurkar.github.io/SQuAD-explorer/), [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). The derived corpus and page carry this notice. The committed fixture is original synthetic text and copies no SQuAD passage. EmbeddingGemma 2, Orama and Transformers.js are Apache-2.0; ONNX Runtime is MIT. Example source is AGPL-3.0-only. [ADR-0019](../../docs/adr/0019-in-browser-retrieval.md) records the browser-built retrieval decision and its limits.
