# @galaxie/models

LangChain chat providers for galaxie hosts: deterministic mocks, WebLLM worker
inference, Chrome Built-in AI and call-scoped OpenAI-compatible clients.
There is no root export; select a [package subpath](package.json).

## Install

This is a private workspace package. At the repository root, use Node 24 and pnpm
11, run `pnpm install --frozen-lockfile`, then `pnpm build`. Workspace consumers
declare `@galaxie/models` as `workspace:*`; peer requirements and optional provider
peers are listed in [package.json](package.json).

## Minimal mock

```ts
import { MockChatModel } from '@galaxie/models/mock';

const model = new MockChatModel({
  Hello: { id: 'reply-1', text: 'Hello learner' },
});
const reply = await model.invoke('Hello');
```

This host-side example makes no network request. In an agent, use the adapter's
`host.langchain.chatModel(role)` and forward the node config. Register providers
by ID in `services.chatModels` and supply descriptors and role routes through
`CreateOptions.models`; calling a provider directly bypasses routing policy.

`/webllm` needs a host-owned worker importing `/webllm/worker`. The host owns provider
handles: instance and runtime disposal never unload them. A WebLLM handle and its
worker can serve multiple instances or runtimes in the same page through one FIFO
queue. The host calls `handle.dispose()` when the last consumer is gone; it unloads
once and is idempotent. There is no reference counting or automatic unload.

`/builtin-ai` runs on the page and separates readiness probing from an intentional
download. Its sessions belong to individual calls: cancelling or disposing one
consumer destroys its session without destroying another consumer's in-flight
session. `/openai` supplies `openAICompatible` for short-lived, per-call host
credentials. All automated model tests use fakes; the real device demonstrations
are recorded in the [M2 exit record](../../docs/m2-exit-record.md).
Shared-model lifetime has [fake-engine and fake Prompt API conformance evidence](../../tests/conformance/shared-model-lifetime.test.ts)
on Node and headless Chromium only. Real prefill abort latency remains unmeasured.

## User endpoints

`openAICompatible` reports `unreachable` when a request fails before any HTTP
response for a `user-device` destination, or a `user-endpoint` whose literal host
is loopback, RFC 1918, link-local, IPv6 unique-local or `.local`. Its fixed message
lists Local Network Access denial, CORS not allowing the app origin (for example
`OLLAMA_ORIGINS`), and a stopped server as possible causes. These failures cannot
be distinguished by page code. The selected provider never falls back after
dispatch. HTTP statuses, cancellation and timeouts keep their existing mappings;
other destinations and public user endpoints keep `unavailable` network errors.

The LangGraph adapter supplies the selected destination on every provider dispatch,
including preconstructed models and concurrent roles sharing one model. This
call metadata stays out of SDK requests and leaves constructor settings unchanged.
Direct calls default to `user-endpoint`; supply `destination: 'host-server'` or
`'third-party'` when using a proxy directly. This classification neither resolves
DNS nor broadens permitted URLs: LAN URLs still require HTTPS. Errors contain no
endpoint URL, host, upstream text or cause. Raw host callback errors remain
host-only under the [diagnostic contract](../../docs/system-design.md#84-a-model-call).

[AT-24 conformance tests](../../tests/conformance/openai-provider.test.ts) exercise
closed loopback ports on Node and Chromium and a no-CORS server in Chromium,
without real inference. A real Ollama run and real LNA grant/denial still require
human verification.

See [coding guidance](AGENTS.md), [model routing and provider limits](../../docs/system-design.md#84-a-model-call)
and [the baseline](../../docs/adr/0012-security-baseline.md).
Code is AGPL-3.0-only; closed-source use requires a [commercial license](../../COMMERCIAL-LICENSE.md).
