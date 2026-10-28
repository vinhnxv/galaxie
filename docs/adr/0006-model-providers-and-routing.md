# ADR-0006: Model providers, destination classes and per-role routing

- **Status:** Accepted (the in-browser engine to ship is chosen by Spike B, before M2)
- **Date:** 2026-10-28
- **Related:** brief §3, §10, §14.2, §16.2; ADR-0012, ADR-0014, ADR-0016
- **Revisions:**
  - 2026-10-28, after an external read-only review and before any implementation:
    - destination classes name the final recipient;
    - Built-in AI language and worker limits;
    - data labels layered on top;
    - spending limits on the host proxy.
  - 2026-10-28, with brief 0.3 (ADR-0016): Spike B runs before M2, judges engines on functional checks and records its numbers as demonstrations; onnxruntime-web with galaxie's own decoding loop joins the candidates; providers enforce a JSON Schema while decoding where they can; Built-in AI no longer needs a role eval.

## Context

- The vision starts from local inference on WebGPU, but local is not always possible or good enough.
- Users who already have an LLM API or endpoint want to plug it in.
- There are four in-browser options:
  - **WebLLM:** the strongest LLM path on WebGPU.
  - **Transformers.js v4:** a new C++ WebGPU runtime, many architectures, and experimental structured output in 4.3.
  - **Chrome Built-in AI (Prompt API):** a browser-managed model shared across sites; desktop Chrome only.
  - **onnxruntime-web directly:** the runtime under Transformers.js, driven by galaxie's own generation loop, as in the local tutor spike. It gives full control of decoding; galaxie then owns tokenization, the chat template and the loop.
- Storage is partitioned per origin, so in-browser engines make every site download weights again.
- A single global `local-only` / `remote-allowed` switch is too coarse. In the tutor, the quiz comes from shared lesson content, while the writing feedback reads the learner's own text.

Founder decision (2026-10-28):

- remote LLM in the MVP through an OpenAI-compatible provider, in host-proxy and user-endpoint modes, with credentials from a host callback;
- Transformers.js v4 evaluated in Spike B alongside WebLLM and the Prompt API, with the winner shipped next to Built-in AI.

## Decision

1. **Destination classes:** `in-browser`, `user-device`, `user-endpoint`, `host-server`, `third-party`.
   - Policy is an allowlist of classes **per model role**. The UI always shows the class in use.
   - A class names the **final recipient**, not the first hop. A host proxy that forwards to an external provider is `third-party`; the host declares this when it configures the provider.
   - Run-level data labels (ADR-0014) apply on top of per-role policy and can only narrow it.
2. **Providers in the MVP:**
   - one in-browser engine, chosen by Spike B before M2;
   - Chrome Built-in AI where available. It is called from the page, because the Prompt API is not available in workers. It is eligible for a role only when `availability()` supports the role's input and output languages. The documented languages today are English, Japanese, Spanish, German and French, so roles that need Vietnamese cannot use it yet;
   - an OpenAI-compatible provider in host-proxy and user-endpoint modes;
   - a mock provider for CI.
3. **Integration point:** LangChain `BaseChatModel`.
   - `ChatWebLLM` for WebLLM, if Spike B shows it works with a worker engine and per-session context reset; otherwise a thin adapter.
   - `ChatOpenAI` with `baseURL` for OpenAI-compatible endpoints.
   - Thin adapters for Transformers.js or onnxruntime-web, and for the Prompt API.
   - Where a provider can enforce a JSON Schema while it decodes (a strict `response_format`, the Prompt API's `responseConstraint`, or guided decoding in the in-browser engine), the adapter uses it, and `withStructuredOutput` takes the same path (brief §10.6).
   - Galaxie wraps each provider with policy, egress allowlist, consent, budgets, queueing, redaction and capability flags. No in-house model SDK.
4. **Per-role routing:** the agent declares roles and the features they need; the host maps each role to an ordered provider list and an allowed set of classes.
5. **First-run order:**
   1. Built-in AI, if `availability()` supports the role's languages and the host lists it for the role;
   2. the cached in-browser model;
   3. an in-browser download, after consent with the size shown;
   4. a remote provider, only if the role allows it and the user consents.
6. **No silent switch.** Changing class mid-session shows a notice. Moving to a less private class needs consent. When nothing is available, return a typed `unavailable` error.
7. **Credentials:** galaxie never stores provider keys. The host supplies them through `getCredential()` per request. Keys never enter prompts, checkpoints, traces or exports.
8. **Transformers.js:** pin v4; set `device` explicitly and report it; a silent downgrade to WASM is a bug. Use it for non-LLM tasks (classifiers, embeddings, ASR) after the MVP even if it does not win Spike B.
9. **BYOK direct to OpenAI/Anthropic from the browser** is not in the MVP. It returns only through the Phase 5 gate.
10. **Budgets** are reserved before dispatch. A call with unknown usage or price is charged at the role's maximum. Hard spending limits live on the host proxy, because cancelling a request does not guarantee a provider stops billing.

## Alternatives considered

- **Global inference switch (v0.1).** Rejected: too coarse for mixed workloads.
- **Ship WebLLM and Transformers.js both as LLM providers.** Rejected for the MVP: double the testing for one job.
- **Host proxy only, no user endpoints.** Rejected by the founder decision; user endpoints are a key part of "bring your own model".
- **BYOK direct in the MVP.** Rejected: SDKs require `dangerouslyAllowBrowser`, which exposes the key to every script on the origin.
- **Our own model client library.** Rejected: LangChain chat models already cover the wire formats.

## Consequences

- Per-role policy must be enforced in the router, not just documented (AT-04, AT-22).
- User endpoints on `localhost` hit Chrome's Local Network Access prompt and need CORS (`OLLAMA_ORIGINS`). To page code, both failures look like the same network error, so galaxie reports a typed `unreachable` error with the likely causes, never a fallback.
- Built-in AI cannot be pinned and exposes no model version. CI re-runs its smoke tests on Chrome stable and beta, and the host can turn the provider off.
- OpenAI-compatible endpoints differ in schema support, streaming, cancellation, usage reporting and auth. Each tested endpoint type gets its own descriptor.
- The model descriptor (brief §10.5) is required for every provider/model pair.

## Verification

- Before M2, Spike B picks the in-browser engine from functional checks: whether it loads, streams, cancels, runs in a worker, resets context per session and enforces a JSON Schema while decoding. Its numbers are recorded as demonstrations (ADR-0016). Record the result in this ADR.
- The local tutor spike (2026-10-28, `spikes/local-english-tutor/`) is the first evidence on structured output: on one device, 13 of 49 lesson sections failed with free-form JSON and one repair attempt, and none failed with each section's schema enforced while decoding.
- Before M4, Spike D validates host-proxy and user-endpoint paths.
- AT-03, AT-04, AT-22, AT-23, AT-24.
