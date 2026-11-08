# @galaxie-ai/models

LangChain chat providers for galaxie hosts: deterministic mocks, WebLLM worker
inference, ONNX models through Transformers.js, Chrome Built-in AI and call-scoped
OpenAI-compatible clients.
There is no root export; select a [package subpath](package.json).

## Install

```sh
pnpm add @galaxie-ai/models @langchain/core@~1.2.20
```

There is no root export: import a provider subpath (`@galaxie-ai/models/openai`,
`/builtin-ai`, `/webllm`, `/transformers`, `/decision` or `/mock`). Each provider's
library is an optional peer, so install only the ones you use: `@mlc-ai/web-llm@0.2.86`,
`@huggingface/transformers@4.3.2` with `@huggingface/transformers-structured-output@4.3.2`,
or `@langchain/openai@1.6.3`. Peer requirements are listed in [package.json](package.json).
To work on this package, use Node 24 and pnpm 11 at the repository root: run
`pnpm install --frozen-lockfile`, then `pnpm build`. Workspace consumers declare
`@galaxie-ai/models` as `workspace:*`.

## Minimal mock

```ts
import { MockChatModel } from '@galaxie-ai/models/mock';

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

## Output-token limits

WebLLM, Transformers and OpenAI-compatible models accept `maxTokens` per call.
They send the lower of that value and a configured constructor `maxTokens`.
Without a per-call value, constructor behavior is unchanged: WebLLM and
Transformers default to 1024, while OpenAI-compatible models send no limit unless
configured. OpenAI uses the transport's `max_tokens` or `max_completion_tokens`
field for the model, including on tool-bound copies.

The LangGraph, Pyodide and ADK JavaScript adapters forward the route's reservation
through the lease as this per-call limit on invoke and stream. LangGraph caller
`maxTokens` and ADK `maxOutputTokens` can lower it further, including on structured
and repair calls. The Go adapter is not covered. Built-in AI has no output-token
limit and ignores this value. Providers may overshoot and actual usage may differ
from the reservation; router reservation and settlement accounting are unchanged.
Hard spending limits still belong on the host proxy.

Limit coverage uses mocks, fake engines and injected fetch only; no real provider
limit behavior has been measured. `MockChatModel.maxTokens` records the received
limits in call order, including `undefined` for calls without one, shared across
tool-bound copies. This record does not change scripted replies or transcripts.

## Mock decisions

`@galaxie-ai/models/mock` also exports `MockDecisionModel`, `MockDecisionReply`,
`MockDecisionScriptEntry` and `MockDecisionCall`. Script entries run in call order:

```ts
import { MockDecisionModel } from '@galaxie-ai/models/mock';

const model = new MockDecisionModel([
  {
    answers: { route: { value: 'ask', probabilities: { ask: 0.75, answer: 0.25 }, confidence: 0.8 } },
    usage: { inputTokens: 12, outputTokens: 0 },
  },
]);
```

Register this under `services.decisionModels` with a decision-modality descriptor
and call `host.langchain.decide(role, request, config)` from the graph; see
[decision roles](../adapter-langgraph/README.md#decision-roles). The mock fits
core's provider contract structurally without depending on core or validating
replies itself. It returns scripted boolean, single-choice, multiple-choice and
score values with optional probabilities, confidence and usage. No inference,
network call or real-model accuracy is involved.

Entries can instead contain `{ invalid: unknown }` for rejection fixtures or
`{ error: Error }`. Any entry can add `wait: createMockLatch()` for a cancellable
wait. Replies and invalid entries may add `raw` for repair fixtures. `calls` counts
dispatches; `recordedCalls` returns the request, signal, `maxTokens` and optional
`repair` in dispatch order. Requests may contain private data: these records
are test assertions, not telemetry. The host validates complete answers and
applies output checks and settlement; the mock never retries a failed call.

## Structured-output decisions

`@galaxie-ai/models/decision` exports `createStructuredDecisionModel(chat)`. It wraps
an already available chat model that supports the `jsonSchema` call constraint,
including WebLLM, Built-in AI, Transformers.js, OpenAI-compatible models and the
scripted mock. One closed JSON Schema covers every boolean, choice and score
question in one generation; multiple choices use unique arrays of enum keys.
No additional model download or nested text lease is needed.

The wrapper reports actual input and generated output tokens when the chat reply
supplies valid usage; otherwise routing charges the reservation. It returns values
only, never confidence or probabilities, even if generated text volunteers them.
Every confidence gate over these answers therefore asks. The gate itself remains
unimplemented. Core validates values and the adapter owns bounded repair.

```ts
import { createStructuredDecisionModel } from '@galaxie-ai/models/decision';
import { MockChatModel } from '@galaxie-ai/models/mock';

const request = {
  state: 'Example message',
  questions: { ask: { type: 'boolean' as const, instructions: 'Ask a follow-up?' } },
};
const prompt = `<state>\n${JSON.stringify(request.state)}\n</state>\n<questions>\n${JSON.stringify(request.questions)}\n</questions>`;
const chat = new MockChatModel({
  [prompt]: { id: 'decision', text: '{"ask":true}' },
});
const model = createStructuredDecisionModel(chat);
const result = await model.decide(request, {
  signal: new AbortController().signal, maxTokens: 64,
});
```

For routed calls, register the wrapper in `services.decisionModels` under an
explicit decision descriptor preserving the source model's destination, languages,
pricing, credentials and readiness/download requirements. Use
`host.langchain.decide(role, request, config)` so policy and accounting apply.
The provider returns generated `raw` text only for output checks and repair;
the adapter never publishes or stores it. A repair receives the previous raw
reply and a fixed instruction, with no validator diagnostics.

## Transformers (ONNX models)

`/transformers` runs an ONNX chat model through Transformers.js inside a host-owned
Worker ([ADR-0021](../../docs/adr/0021-in-browser-onnx-chat-provider.md), Proposed).
The library and the optional constraint package are optional peers: hosts that do
not use the provider install nothing. `onnxruntime-web` arrives with the library;
a host that imports its `?url` assets in its own Worker entry should list it as its
own dependency. The package ships no
model record; a maintainer pins one with `scripts/pin-onnx-model.ts`, which prints
the license it reads at that revision and the total selected bytes. It selects a single
`model` export or the text-only `embed_tokens` and `decoder_model_merged` pair
with dtype-matched external data shards, excluding vision/audio encoders. Both
use the same flat per-file record and verified-cache loader. Library licenses as read in the installed package manifests:
`@huggingface/transformers` and `@huggingface/transformers-structured-output`
Apache-2.0, `onnxruntime-web` MIT. Each model has its own license, which the
record's maintainer must read and record; Gemma terms differ from Apache-2.0.

```ts
// worker.ts: bundled by the host as a module worker
import ortMjs from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';
import ortWasm from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import { startTransformersWorker } from '@galaxie-ai/models/transformers/worker';

startTransformersWorker({ ort: { mjs: ortMjs, wasm: ortWasm } });

// page.ts: `record` is a pinned TransformersModelRecord; `worker` comes from your
// Trusted Types worker policy.
import {
  checkTransformersModel,
  loadTransformersEngine,
  TransformersChatModel,
  type TransformersChatEngine,
} from '@galaxie-ai/models/transformers';

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

Tool formats are record-declared: `hermes` uses a JSON body within `<tool_call>`;
`xml` uses `<tool_call><function=NAME><parameter=ARG>VALUE</parameter></function></tool_call>`.
Both hold markup back while streaming and allow at most 16 blocks. XML tolerates
whitespace between tags and trims values. Values stay strings unless the bound
parameter schema declares an integer, number or boolean with an exact textual
round trip (integers must also be safe). Nested functions, duplicate parameters
and unterminated blocks become raw invalid tool calls. The pin script parses a
rendered probe call to detect the format; unknown syntax leaves `toolFormat` absent
and `bindTools` fails `unsupported`.

Register the provider with destination `in-browser`, zero pricing and the features
its tests support: `streaming` and `cancellation`, plus `tool-calling` when the
record has `toolFormat: 'hermes'` or `'xml'` (routed `bindTools` is available through the ADK and LangGraph.js adapters; LangGraph.js coverage uses mock models only, with no real-model result) and `structured-output` when the constraint
package is installed. `availability` and `download` arrange consent before any file
is fetched; a refusal fetches nothing. Files are checked against the record's size
and SHA-256 before they are stored. The record names one device (`webgpu` or
`wasm`) and the provider never falls back between them. Only the Worker needs the
model host in `connect-src` and `'wasm-unsafe-eval'`; galaxie adds no directive.
All tests use a fake runtime; there is no real-device run, so output quality, speed
and memory are unmeasured ([unsupported list](../../docs/unsupported.md#models-and-providers),
[device matrix](../../docs/device-matrix.md#untested-or-unmeasured)).

## OpenAI-compatible tools

`OpenAICompatibleChatModel.bindTools(tools, kwargs?)` returns a new model offering
those tools and shares the original call-scoped SDK model; it leaves the receiver
unchanged. `kwargs.tool_choice` (or a call's `tool_choice`) accepts unset, `auto`,
`none`, `required`, a bound tool's name, or
`{ type: 'function', function: { name: 'bound_tool_name' } }`. Other choices fail
with fixed `unsupported` errors. `none` and an empty tools array offer no tools;
tool replies then fail just as they do on an unbound model.

Enabled tools support text alongside calls, parallel streamed calls, and assistant
and tool-result history with the provider's call IDs preserved. Malformed argument
JSON is returned as `invalid_tool_calls`. Unknown tool names, more than 16 calls
in one reply, and refusals fail with fixed provider errors. A tool request and
`jsonSchema` structured output cannot share one call (`unsupported`). The provider
returns fresh messages without raw endpoint metadata and never includes arguments
or tool results in thrown errors.

The host must still declare the provider's `tool-calling` feature for routed roles.
Use `host.langchain.chatModel(role).bindTools(...)` with capability tools so routing,
consent, labels, budgets and output checks apply; a native `ToolNode` must use
`{ handleToolErrors: false }`. Coverage uses injected-fetch mocks and loopback
JSON/SSE fixtures on Node and Chromium only; no real-endpoint or real-model result
is claimed.

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
