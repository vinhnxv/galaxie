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

`/webllm` needs a host-owned worker importing `/webllm/worker`.
`/builtin-ai` runs on the page and separates readiness probing from an intentional
download. `/openai` supplies `openAICompatible` for short-lived, per-call host
credentials. All automated model tests use fakes; the real device demonstrations
are recorded in the [M2 exit record](../../docs/m2-exit-record.md).

See [coding guidance](AGENTS.md), [model routing and provider limits](../../docs/system-design.md#84-a-model-call)
and [the baseline](../../docs/adr/0012-security-baseline.md).
Code is AGPL-3.0-only; closed-source use requires a [commercial license](../../COMMERCIAL-LICENSE.md).
