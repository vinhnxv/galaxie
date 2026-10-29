---
title: M4 OpenAI-Compatible Provider - Plan
type: feat
date: 2026-10-29
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# M4 OpenAI-Compatible Provider - Plan

## Goal Capsule

- **Objective:** ship `@galaxie/models/openai`, an OpenAI-compatible chat provider for the router. It covers two modes:
  - **host proxy:** the destination is `host-server` or `third-party`;
  - **user endpoint:** the destination is `user-endpoint` or `user-device`.

  Credentials come only from the per-call host callback (ADR-0006; brief §8.4, §10.5 and §16.6). This is the first M4 slice.
- **Means:**
  - a thin LangChain `BaseChatModel` wrapper in `packages/models/src/openai/`. It delegates to a call-scoped `ChatOpenAICompletions` from `@langchain/openai` 1.6.3. That is the Chat Completions implementation inside `ChatOpenAI`, the transport ADR-0006 names;
  - a provider factory that the router's existing credential path calls once per call;
  - fixed typed errors;
  - tests with an injected `fetch` on Node and in Chromium;
  - one conformance test through the router;
  - docs.
- **Authority, highest first:**
  1. `AGENTS.md`.
  2. Accepted ADRs, in particular ADR-0002, ADR-0006, ADR-0012, ADR-0014 and ADR-0017. Do not edit any ADR.
  3. This plan.
  4. Brief §8.4, §9.4, §10.5 and §16.6.
  5. `docs/system-design.md`.
  6. The Spike D report, `spikes/d-remote-paths/README.md`. It is evidence only: never import or copy spike code.
- **Execution profile:** autonomous and offline, in Node and headless Chromium. Work on the existing branch `m4/openai-compatible-provider` and open one pull request against `main`. Run U1 to U5 in order, with `pnpm check` after each.
- **Already done on this branch:** `@langchain/openai` 1.6.3 is added to `packages/models` as an exact optional peer and a dev dependency. The root `pnpm-lock.yaml` is updated (it resolves `openai` 7.42.0) and installed, and it is committed with this plan. Do not change any dependency further.
- **Stop conditions:** stop and open a draft pull request that names the blocker when any of these happens:
  - an existing test assertion must change;
  - a conformance golden or the compatibility matrix would change;
  - an ADR would change;
  - any dependency or the lockfile would change again;
  - a credential, prompt, completion or upstream response body would reach an error, span, diagnostic, snapshot, checkpoint or log;
  - `pnpm check` still fails after three focused fix attempts on the same cause.
- **Who finishes:** the implementing agent opens the pull request and stops. It never merges.

---

## Product Contract

### Requirements

**Provider surface**

- R1. `@galaxie/models/openai` exports `openAICompatible(options)`, which returns the router's credential-factory form: `({ credential }) => BaseChatModel`. The router already calls that form per call with the lease credential, in `packages/adapter-langgraph/src/routed-chat-model.ts`. The options are:
  - `baseURL`: an absolute URL. It must use `https:`, or `http:` only for the loopback hosts `localhost`, `127.0.0.1` and `[::1]`. It must carry no username, password, query or fragment. Anything else is rejected with `ModelError('invalid')` at construction.
  - `model`: a non-empty model identifier sent to the endpoint.
  - `maxTokens`: an optional per-request output limit, a positive safe integer. It is sent as the OpenAI `max_tokens` / `max_completion_tokens` field, whichever the installed `ChatOpenAICompletions` uses. It is separate from the router's reservation, as for WebLLM.
  - `temperature`: optional.
  - `fetch`: optional. It is passed to the SDK client and used by tests and hosts that need a custom transport.
  - `headers`: optional extra request headers. A reserved header (`authorization`, `cookie`, `host`) is rejected with `invalid`.

  The function also exports `OpenAICompatibleChatModel` and the option and call-option types.
- R2. **One `ChatOpenAICompletions` per call.**
  - Use the publicly exported `ChatOpenAICompletions` class from `@langchain/openai`, not `ChatOpenAI`. `ChatOpenAI` 1.6.3 routes some model IDs (any containing `codex`, `gpt-5.6`, and some `-pro` IDs) to the Responses API, and `useResponsesApi: false` cannot turn that off. `ChatOpenAICompletions` always calls `/chat/completions`. Its `@internal` JSDoc tag is a re-check item on every `@langchain/openai` upgrade, and the docs say so.
  - The factory constructs the wrapper, and the wrapper constructs one `ChatOpenAICompletions` with:
    - `apiKey` set to the credential;
    - `configuration.baseURL`;
    - `maxRetries: 0`, so one routed call owns at most one dispatched request (Spike D: the default retries 429 and 500 six times);
    - `streamUsage: true`;
    - the SDK's `timeout` left at its default;
    - `configuration.logLevel: 'off'`, so the SDK never logs request bodies, even when `OPENAI_LOG` is set on a Node host. The docs note that on Node the SDK may still read `OPENAI_CUSTOM_HEADERS`, `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID` and `OPENAI_ORGANIZATION`. Pass `organization` and `project` explicitly as `null` or `undefined` if the installed types allow it to suppress env lookup; otherwise document the limit.
  - The credential is held only in that call-scoped instance and is never stored on a module or class field that outlives the call.
  - An empty or non-string credential throws `invalid` before any request is made.
- R3. **Keyless endpoints are out of scope.** A local server that needs no key still receives the host-supplied credential as a bearer token, and the docs say so. Removing `Authorization` is not attempted in this slice.
- R4. **Messages.** The wrapper accepts the same text-only message shapes as the other providers, through `mapMessages` in `packages/models/src/messages.ts`:
  - an optional leading system message, then user and assistant turns, ending in a user turn;
  - no tool calls.

  Anything else rejects `invalid` before dispatch. The descriptor guidance lists the features `['streaming', 'cancellation', 'structured-output']`, never `tool-calling` (brief §9.5).

**Calls**

- R5. **Non-streaming** `_generate` returns one `AIMessage` with string content and `usage_metadata` from the response's `usage`. The router settles the budget from `usage_metadata`. When the endpoint reports no usage, the message carries none, so the router charges the reservation (system design §8.4).
- R6. **Streaming** `_streamResponseChunks` yields text chunks in order. Usage arrives once on the final chunk, through `stream_options.include_usage`. It never yields reasoning or tool-call deltas; a tool-call delta fails the call with `ModelProviderError`.
- R7. **Cancellation.** The call's `AbortSignal` is passed through to the inner model, and the wrapper rejects every abort itself, following `builtin-ai/chat-model.ts`.
  - Call `options.signal?.throwIfAborted()` at four points:
    - before dispatch;
    - after each inner chunk;
    - after the inner stream ends;
    - first in the catch block.

    Every abort then rejects with `signal.reason`.
  - This is required because the SDK's SSE iterator, and `ChatOpenAICompletions._streamResponseChunks` with it, return normally on abort with partial text. A mid-request non-streaming abort becomes a plain `Error` named `AbortError`. The router does not map either case, so a delegating wrapper would settle an aborted stream as a success.
  - An abort before dispatch makes no request. An abort mid-stream closes the response body, rejects, and never yields a successful end.
- R8. **Structured output.**
  - The engine-neutral `jsonSchema` call option, used by the router's routed `withStructuredOutput`, is sent as `response_format: { type: 'json_schema', json_schema: { name: 'output', strict: true, schema } }`.
  - Provider-level `withStructuredOutput` reuses `structuredOutput` in `packages/models/src/structured-output.ts`, as WebLLM and Built-in AI do.
  - Validation of the reply stays where it is today: in the router for routed calls, and in the shared parser for provider-level calls. The exception is non-streaming calls: there, `ChatOpenAICompletions` calls the SDK's `chat.completions.parse()`, which rejects malformed JSON (`SyntaxError`), truncation (`LengthFinishReasonError`) and filtered replies (`ContentFilterFinishReasonError`) before the router's parser runs. Those map to `ModelProviderError` (R10). The router still validates well-formed JSON that is schema-invalid.
- R9. **No inner tracing.** The wrapper calls the inner model's `_generate` and `_streamResponseChunks` directly with `{ signal, response_format }` and no run manager. It never calls `invoke`, `stream` or `generate` on the inner model: those run `ensureConfig`, which picks up the outer run's callbacks through `AsyncLocalStorage`, and `CallbackManager.configure`, which adds a LangSmith tracer when tracing env vars are set. Spans and events come only from the routed model (ADR-0016).

**Errors**

- R10. Every failure is a fixed typed error without `cause`, and never carries a message, body, header or credential from the endpoint or the SDK. The mapping is:

  | Condition | Error |
  | --- | --- |
  | Invalid options or messages | `ModelError('invalid')` |
  | HTTP 401 or 403 | `ModelError('unavailable', 'not_allowed')` |
  | HTTP 429 | `ModelError('unavailable', 'rate_limited')` |
  | HTTP 408, 5xx, or the SDK timeout (an error named `TimeoutError`) | `ModelError('unavailable', 'endpoint_failed')` |
  | A network or CORS failure where no HTTP status is visible (the SDK's `APIConnectionError`; Spike D) | `ModelError('unavailable', 'network')` |
  | HTTP 400, 404 or 422, and other 4xx | `ModelProviderError` |
  | A malformed or empty response, a refusal, or a parse-helper `SyntaxError`, `LengthFinishReasonError` or `ContentFilterFinishReasonError` | `ModelProviderError` |
  | An abort | the standard abort error (R7) |

  `rate_limited`, `endpoint_failed` and `network` are added to `ModelUnavailableReason` in `packages/models/src/errors.ts`. Classification lives in a new `src/openai/classify.ts` that follows `webllm/classify.ts` and `builtin-ai/classify.ts`. It reads `status` first; for 429 it uses `status`, never `name`, because `AsyncCaller` renames those errors. It then uses `instanceof` against the SDK classes re-exported as statics of `OpenAIClient` from `@langchain/openai`, for example `OpenAIClient.APIConnectionError`, with `status === undefined`. Never classify by class-name string: openai 7.42.0 never sets `name`, and host bundles minify constructor names. Abort is handled before classification (R7).
- R11. **Credential hygiene,** tested:
  - after a 401, a 500, a network failure and a malformed body, no thrown error's own properties, `message` or `stack`, and no recorded span attribute or event, contain the credential or a body marker string;
  - the credential appears in exactly one place, the outgoing `Authorization` header seen by the injected `fetch`;
  - the request URL never carries the credential;
  - two consecutive routed calls, with distinct credentials from `getCredential`, each send only their own credential, and the second request carries no trace of the first.

**Router integration and docs**

- R12. **Conformance.** A test in `tests/conformance/` routes a role through `host.langchain.chatModel(role)` to the provider with an injected `fetch`, on Node and Chromium. It covers:
  - a host descriptor `{ destination: 'host-server', modality: 'text', features: ['streaming', 'cancellation', 'structured-output'], pricing: { inputPerToken, outputPerToken }, credential: true }`;
  - consent required for `host-server` (an existing router rule);
  - `getCredential` called once per call;
  - usage settled from `usage_metadata`;
  - routed `withStructuredOutput` sending `response_format` and validating the reply;
  - a streamed call through LangGraph `messages`;
  - abort;
  - a 429 surfacing as `unavailable` without retry. The fake `fetch` counts exactly one request;
  - a non-JSON structured reply failing with the provider error code, and a well-formed but schema-invalid reply failing with the router's `invalid`.

  This file is also the Chromium lane for the provider tests. The Vitest browser project covers `tests/conformance` but not `packages/models/test`, as it is for the WebLLM and Built-in AI providers.
- R13. **Dependency boundary.** `scripts/check-dependencies.ts` is updated deliberately:
  - the models peers are `@langchain/core`, optional `@mlc-ai/web-llm` 0.2.86 and optional `@langchain/openai` 1.6.3;
  - `@langchain/openai` may be imported only from `packages/models/src/openai/*`;
  - `@galaxie/models/openai` is an allowed import where the other subpaths are allowed.

  `packages/models/package.json` gains the `./openai` export. The build emits `dist/openai/`.
- R14. **Docs.**
  - System design §8.4 gains the OpenAI-compatible provider. It covers:
    - the two modes and their destination classes;
    - the credential-callback flow and its limits: the credential is readable by page code (ADR-0012), so hosts should hand out short-lived, host-proxy-scoped tokens;
    - `maxRetries: 0`;
    - the CORS request headers a host proxy must allow, from Spike D: `authorization`, `content-type` and the `x-stainless-*` set, including `x-stainless-helper-method` for structured output, re-checked on SDK upgrades;
    - an abort closing the socket, which does not guarantee that provider billing stops;
    - keyless endpoints receiving a bearer token anyway;
    - credential-to-origin binding, which is the host's job. `getCredential` receives the `providerId`, and each provider ID maps to one fixed `baseURL`, so the host must return a credential that is valid only for that provider's origin. A host-proxy token is never returned for a user-endpoint provider, and a user-endpoint `baseURL` that comes from user settings receives only the user's own key for that endpoint, never a host-issued token;
    - the provider's `maxTokens` being separate from the router's reservation.
  - Also update `packages/models/README.md` if it exists, and the `AGENTS.md` and `README.md` status paragraphs, by one or two sentences each. Never describe the provider as secure.

### Scope Boundaries

- **Later M4 slices:** MCP, confirmations, a second host, and wiring the provider into `examples/host-local`.
- **Out of scope:**
  - keyless endpoints and `Authorization` removal;
  - Ollama and Chrome LNA;
  - tool calling;
  - the Responses API;
  - reasoning options;
  - per-endpoint schema-support probing;
  - automatic retry.
- No real provider, key or network access; tests use an injected `fetch`.

### Assumptions

- `ChatOpenAICompletions` 1.6.3 accepts `configuration.fetch` and `configuration.baseURL`, sets `dangerouslyAllowBrowser: true` by default (Spike D), and forwards `signal`.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Wrap `ChatOpenAICompletions` instead of writing a client.** ADR-0006 names `ChatOpenAI`, and this is its Chat Completions half, which keeps a fixed wire path. The wrapper exists to:
  - pin `maxRetries: 0`;
  - map `jsonSchema`;
  - restrict messages;
  - replace every error with a fixed one.
- KTD2. **Use a call-scoped instance.** The credential lives in the router's lease, and the model instance dies with the call, so the provider holds no credential state between calls.
- KTD3. **Map errors by status class only,** so no SDK message, which may quote the upstream body, ever crosses the boundary.

### Output Structure

- `packages/models/src/openai/{index.ts,chat-model.ts,classify.ts}`, `src/errors.ts`, `package.json` exports.
- `packages/models/test/openai-chat-model.test.ts` and `test/support/fake-openai-fetch.ts`.
- `tests/conformance/openai-provider.test.ts`.
- `scripts/check-dependencies.ts`.
- `vitest.config.ts`: alias `@galaxie/models/openai` to `packages/models/src/openai/index.ts`, and add `@langchain/openai` to the browser `optimizeDeps.include` if the other providers' dependencies are listed there.
- `tests/conformance/tsconfig.json`: a `paths` entry for `@galaxie/models/openai`, if the other subpaths have one.
- Docs.

Widen the file list only for type fallout, and record that in the pull request.

### Implementation Constraints

- New files carry the SPDX header. Relative imports end in `.js`, type-only imports use `import type`, exported functions declare return types, and there is no `enum`.
- The fake `fetch` returns real `Response` objects: JSON bodies, and SSE bodies through a `ReadableStream`. It records each request's method, URL, headers and parsed body. The same fake runs on Node and in Chromium.

## Implementation Units

- **U1. Errors and classify.**
  - First, update the peer-list rule in `scripts/check-dependencies.ts` (R13's first bullet). The branch already adds the peer, so `pnpm check` fails until this rule changes.
  - Add the three reasons.
  - Write `src/openai/classify.ts`.
  - Write unit tests for every row of the R10 table, using SDK error instances built through `OpenAIClient.<ErrorClass>` from `@langchain/openai`. `openai` is not a direct dependency, so it cannot be imported under pnpm's strict layout.
- **U2. Provider.**
  - Write `chat-model.ts` and `index.ts`, and the package export.
  - Test on Node in `packages/models/test`. The Chromium half runs in U4's conformance file. Test:
    - options validation;
    - the credential in the header only;
    - a non-streaming call and a streaming call, both with usage;
    - an endpoint without usage;
    - abort before dispatch and abort mid-stream;
    - `jsonSchema` mapped to `response_format`;
    - provider-level `withStructuredOutput`;
    - one request per call under 429 and 500;
    - a model ID `gpt-5.6`, whose request the fake `fetch` sees at `/chat/completions`;
    - a mid-stream abort that rejects and never yields a successful end;
    - the R11 hygiene checks.
- **U3. Dependency checks.** Add the import-boundary and subpath rules to `scripts/check-dependencies.ts`, and confirm that `pnpm check:deps` passes.
- **U4. Conformance.** The R12 test.
- **U5. Documentation.** R14.

## Verification Contract

| Gate | Command or check | Applies to |
| --- | --- | --- |
| Full local CI | `pnpm check` | every unit |
| CI-mode tests | `CI=true pnpm test` | before the PR |
| Behavior kept | Every pre-existing test passes with unchanged assertions. | every unit |
| Protected paths | `git diff --stat main -- tests/conformance/golden tests/conformance/compatibility-matrix.json docs/adr` is empty. | before the PR |
| Dependencies | `pnpm install --frozen-lockfile --offline` passes. `package.json` and `pnpm-lock.yaml` are unchanged after the plan commit. | before the PR |

## Definition of Done

- U1 to U5 are complete.
- A routed role reaches an OpenAI-compatible endpoint with a per-call credential, one request per call, settled usage, structured output, streaming and abort.
- No credential or endpoint text reaches errors or spans.
- `pnpm check` and `CI=true pnpm test` pass, and GitHub CI is green.

## Appendix

### Sources

- ADR-0006 (decision 2, `ChatOpenAI` with `baseURL`), ADR-0012 and ADR-0016.
- Brief §8.4, §9.4, §10.5 and §16.6.
- `packages/core/src/models.ts`: `ModelDescriptor`, `ModelRouting.getCredential` and `ModelCall.credential`.
- `packages/adapter-langgraph/src/routed-chat-model.ts`: the credential-factory call and usage settlement.
- `packages/models/src/{errors.ts,messages.ts,structured-output.ts}`, and `webllm/` and `builtin-ai/` for the provider pattern.
- `spikes/d-remote-paths/README.md`: the header allowlist, retry behavior and error classes.
