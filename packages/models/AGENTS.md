# @galaxie-ai/models: coding guidance

## Purpose

Supply LangChain chat models for trusted host registration: a deterministic mock,
WebLLM in a worker, the page-only Chrome Prompt API and OpenAI-compatible endpoints.
See the [README](README.md) and [model flow](../../docs/system-design.md#84-a-model-call).

## Entry points

- There is no `@galaxie-ai/models` root export; use a declared subpath.
- `/mock`: `MockChatModel`, `MockDecisionModel`, `MockModelError`, `createMockLatch` and script types.
- `/decision`: `createStructuredDecisionModel` and structural request, result and option types.
- `/webllm`: `loadWebLLMEngine`, `WebLLMChatModel`, `checkWebLLMModel`,
  `defaultWebLLMModel`, engine handles and record/options types.
- `/webllm/worker`: `startWebLLMWorker` for a host-bundled worker.
- `/builtin-ai`: `BuiltInAIChatModel`, `checkBuiltInAI`, `prepareBuiltInAI`.
- `/openai`: `openAICompatible`, `OpenAICompatibleChatModel` and option types.
- `/webllm`, `/builtin-ai` and `/openai` export `ModelError` and its code/reason types.
  Check [package exports](package.json) and the corresponding `src/*/index.ts`.

## Do

Use a scripted model in tests, without loading a real provider:

```ts
import { MockChatModel } from '@galaxie-ai/models/mock';

const model = new MockChatModel({
  Hello: { id: 'reply-1', text: 'Hello learner' },
});
await model.invoke('Hello');
```

- Hosts register models under provider IDs in `services.chatModels`; agents call
  `host.langchain.chatModel(role)` so router policy and budgets apply.
  Register decision providers in `services.decisionModels` and call
  `host.langchain.decide(role, request, config)` for decision roles.
- The host owns provider handles. Instance and runtime disposal never unload them;
  the host disposes a WebLLM handle when its last consumer is gone. A handle/worker
  can serve multiple instances or runtimes in the same page through its shared FIFO.
- Probe Built-in AI languages; prepare downloads only from an intentional click.
- Use `openAICompatible` as a per-call factory with credentials from the host.
- Every routed provider call receives the selected destination as adapter-owned
  call metadata, for both factories and preconstructed models. Direct
  OpenAI-compatible calls default to `user-endpoint`; set `destination` explicitly
  for a host proxy. Network failures before any response on local user endpoints
  fail `unreachable` with fixed likely causes; never fall back after dispatch.

## Never

- Never download weights, load the real WebLLM engine or call a real `LanguageModel`
  global in tests; use injected fakes and restore any pre-existing global.
- Never ship provider keys in bundles or place them in model messages.
- Never retry a dispatched failed call silently on another destination.
- Never claim SRI covers weight shards or that browser-managed model identity is pinned.
- Never add raw provider text or a cause to typed provider errors.

## Limits

WebLLM resets context per queued request; prefill abort latency and KV-cache costs
remain unmeasured. Shared-handle lifetime has fake-engine evidence on Node and
Chromium only; there is no reference counting or automatic unload. Cached weights
are not a loaded engine. Built-in AI destroys one session per completed or cancelled
call, without destroying another consumer's in-flight session. It is page-only,
reports no usage or download byte size, and ignores `maxTokens` and temperature.
Router token reservations are separate from a provider's output limit.
Real-device evidence is limited to the [exit records](../../docs/m2-exit-record.md).

## Tests

[test/](test/) holds mock, fake-engine, fake Prompt API and injected-fetch tests.
Run `pnpm exec vitest run --project node packages/models/test` and
`pnpm test tests/conformance/webllm-provider.test.ts tests/conformance/builtin-ai-provider.test.ts tests/conformance/openai-provider.test.ts`
for Node and Chromium integration. Shared-consumer lifetime is covered by
`pnpm test tests/conformance/shared-model-lifetime.test.ts` on both lanes.
Run `pnpm check` before completion.
