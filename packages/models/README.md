# @galaxie/models

LangChain chat providers for galaxie hosts: deterministic mocks, WebLLM worker
inference, ONNX models through Transformers.js, Chrome Built-in AI and call-scoped
OpenAI-compatible clients.
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

## Transformers (ONNX models)

`/transformers` runs an ONNX chat model through Transformers.js inside a host-owned
Worker ([ADR-0021](../../docs/adr/0021-in-browser-onnx-chat-provider.md), Proposed).
The library and the optional constraint package are optional peers: hosts that do
not use the provider install nothing. `onnxruntime-web` arrives with the library;
a host that imports its `?url` assets in its own Worker entry should list it as its
own dependency. The package ships no
model record; a maintainer pins one with `scripts/pin-onnx-model.ts`, which prints
the license it reads at that revision. Library licenses as read in the installed package manifests:
`@huggingface/transformers` and `@huggingface/transformers-structured-output`
Apache-2.0, `onnxruntime-web` MIT. Each model has its own license, which the
record's maintainer must read and record; Gemma terms differ from Apache-2.0.

```ts
// worker.ts: bundled by the host as a module worker
import ortMjs from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';
import ortWasm from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import { startTransformersWorker } from '@galaxie/models/transformers/worker';

startTransformersWorker({ ort: { mjs: ortMjs, wasm: ortWasm } });

// page.ts: `record` is a pinned TransformersModelRecord; `worker` comes from your
// Trusted Types worker policy.
import {
  checkTransformersModel,
  loadTransformersEngine,
  TransformersChatModel,
  type TransformersChatEngine,
} from '@galaxie/models/transformers';

// `??=` keeps the first result: a rejected load stays rejected for this handle, so recovery
// needs a new handle, as for WebLLM.
let loading: ReturnType<typeof loadTransformersEngine> | undefined;
const load = (allowDownload: boolean) =>
  (loading ??= loadTransformersEngine({ worker, model: record, allowDownload }));
const engine: TransformersChatEngine = {
  modelId: record.modelId,
  toolFormat: record.toolFormat,
  async *stream(request, signal) {
    yield* (await load(false)).stream(request, signal);
  },
};
// models: { availability: () => checkTransformersModel({ model: record }),
//           download: async () => { await load(true); return true; } }
// services: { chatModels: { local: new TransformersChatModel(engine) } }
```

Register the provider with destination `in-browser`, zero pricing and the features
its tests support: `streaming` and `cancellation`, plus `tool-calling` when the
record has `toolFormat: 'hermes'` (verified through the ADK adapter's routed model only; the routed LangGraph model has no `bindTools`) and `structured-output` when the constraint
package is installed. `availability` and `download` arrange consent before any file
is fetched; a refusal fetches nothing. Files are checked against the record's size
and SHA-256 before they are stored. The record names one device (`webgpu` or
`wasm`) and the provider never falls back between them. Only the Worker needs the
model host in `connect-src` and `'wasm-unsafe-eval'`; galaxie adds no directive.
All tests use a fake runtime; there is no real-device run, so output quality, speed
and memory are unmeasured ([unsupported list](../../docs/unsupported.md#models-and-providers),
[device matrix](../../docs/device-matrix.md#untested-or-unmeasured)).

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
Code is Apache-2.0 (see [LICENSE](../../LICENSE)).
