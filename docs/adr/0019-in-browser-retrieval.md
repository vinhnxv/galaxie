# ADR-0019: Browser-built retrieval in a maintained example

- **Status:** Proposed
- **Date:** 2026-10-30
- **Related:** brief §1.4, §16.7; ADR-0006, ADR-0012, ADR-0014, ADR-0016

## Context

The maintainer opened the Phase 5 retrieval gate on 2026-10-30 for a maintained RAG example. A visitor indexes the public SQuAD v1.1 validation corpus and pasted text on their own device, then asks a LangGraph.js agent questions. No server embeds, searches or generates. This example deliberately builds its index in the browser to demonstrate indexing arbitrary text. The prebuilt pinned-index format and its update path described in brief §1.4 remain undesigned.

## Decision

One retrieval Worker owns EmbeddingGemma 2 and an Orama index. The host exposes only the bounded `docs.search@1` read capability. Queries and returned passage text carry `private-user` labels, because the index may include pasted text. All generation routes stay `in-browser` and use the existing model router.

Transformers.js is pinned to 4.3.1. The host requests consent for **233.6 MB** (206.7 MB of model files and 26.9 MB of ONNX Runtime) before fetching model files. The Worker checks five revision-pinned files by size and SHA-256 before caching them; Transformers.js reads only that verified cache. ONNX Runtime assets are bundled same-origin. Embedding uses WebGPU and q4, never a silent WASM fallback. Batches contain eight passages truncated at 256 tokens. Query and passage prefixes follow the model's search format. Vectors are cut to 256 dimensions and normalized.

Orama stores IDs, titles, text, source and 256-dimensional vectors. Its custom tokenizer lowercases Unicode letters and numbers without stemming. Vector similarity has an explicit threshold; hybrid weights stay at 0.5/0.5. Persistence uses Orama `save` and `load`, restoring our schema and tokenizer rather than the persistence plugin.

The separate IndexedDB database `galaxie-rag:<appId>` stores a whole index and pasted passages under a fingerprint covering the model revision, embedding settings, library versions, tokenizer, schema version and corpus file digest. A mismatch discards the saved index and rebuilds. This defines the update path for browser-built indexes only. Cache writes and clearing share a Web Lock. Clear broadcasts invalidation so other Workers cannot write deleted pasted text back. Clear deletes the database but retains downloaded model files; a separate action removes those files. This cache is outside galaxie storage's principal, retention and logout controls. Pasted text remains until clear or browser eviction.

The corpus builder pins official SQuAD validation bytes and emits distinct contexts plus linked questions. The generated corpus is not committed. SQuAD is CC BY-SA 4.0, attributed to Rajpurkar et al. (2016), with a notice in the file and page. EmbeddingGemma 2, Orama and Transformers.js are Apache-2.0. Example source uses the repository's Apache-2.0 license.

## Alternatives considered

- A prebuilt pinned index is preferable for a fixed public corpus, as brief §1.4 describes. It does not demonstrate a visitor indexing their own text.
- A custom vector engine would duplicate Orama's full-text, vector and hybrid search.
- A separate embedding Worker would add another protocol and query round trip.
- WASM fallback would change the declared device choice.

## Consequences

Indexing precedes chat-model preparation to reduce simultaneous loading. Two tabs may duplicate build work; multi-tab clear is coordinated. Browser eviction loses the index. Retrieved text can mislead a real model into a wrong cited answer. Delimiters, narrow grants, destination policy, React text rendering and CSP limit particular paths; they do not establish model robustness.

## Verification

The [example README](../../examples/rag-browser/README.md) records mock test evidence, the chosen similarity threshold and unmeasured real-device demonstrations. Index, Worker, cache, agent, injection and host-loop tests run with synthetic fixtures on Node and headless Chromium. The optional Python build adds a real Pyodide Worker with verified wheel installation and LangGraph imports under the unchanged strict CSP, JavaScript-owned routed models and capabilities, and lazy selection, cancellation/failure and disposal coverage. On 2026-10-30, the shared transcript matched in all five lanes: JavaScript on Node/Chromium, Python in Pyodide on Node/Chromium and native CPython. Shared prompt and citation fixtures use deterministic models; they assess execution, not answer quality. [ADR-0018 Verification](0018-python-agents-through-pyodide.md#verification) records the Python executor's narrower scope, local download/startup observations and outstanding recovery/tutor criteria. Model downloads and corpus generation are manual operations outside CI. Real model performance, full-corpus retrieval and reference-device measurements remain unmeasured until explicitly run.
