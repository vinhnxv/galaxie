# @galaxie/adapter-langgraph: coding guidance

## Purpose

Run native LangGraph graphs through core's executor contract, preserving streams,
checkpoint interrupts and resume by interrupt ID. Do not build a second graph engine.
See the [README](README.md) and [contracts](../../docs/system-design.md#6-core-runtime-and-contracts).

## Entry points

- `@galaxie/adapter-langgraph` exports `createLangGraphAdapter`, `STREAM_MODES`
  and `requestInteraction` from [src/index.ts](src/index.ts).
- Exported types include `LangGraphAgent`, `LangGraphHost`, `LangGraphGraph`,
  `LangGraphServices` and `LangGraphChatModel`; there are no public subpaths.
- The adapter uses `@langchain/langgraph/web`; keep Node context imports out.

## Do

Use the host's routed model and forward the node config explicitly:

```ts
import type { LangGraphHost } from '@galaxie/adapter-langgraph';
import type { LangGraphRunnableConfig } from '@langchain/langgraph/web';

async function reply(host: LangGraphHost, config: LangGraphRunnableConfig) {
  return host.langchain.chatModel('feedback').invoke('Practice sentence', config);
}
```

The role and provider must already be declared and bound by the host.

- Pass `config` to `requestInteraction(request, config)`, including after an await.
- Compile graphs with `host.langchain.checkpointer()` and call tools through
  `host.capabilities.call(name, input, config)`.
- Put side effects after interrupts: resuming can re-execute the node prefix.
- Preserve native stream behavior; the host must project display data separately.
- Routed `withStructuredOutput` repairs only when the host opts in per role.
  Forward caller config, `jsonSchema` and the one-based `repairAttempt` through
  ordinary routing. Use the original messages, the last invalid reply and the
  fixed instruction; never include validator text. Preserve both repair limits.
- `includeRaw` retains the last reply with `parsed: null` only on fixed `invalid`
  failures. Budget failures and cancellation propagate without another dispatch.

## Never

- Never rely on implicit async context under the synchronous browser shim.
- Never construct an agent-held provider to bypass the model router.
- Never import Node `AsyncLocalStorage` into this browser adapter.
- Never copy spike adapters into packages or tests.
- Never leak prompt, reply, binding-error or credential text into generated errors
  or instrumentation; use fixed failures and the existing trace policy.

## Limits

Parallel interrupts, static breakpoints, ID-less interrupts and multiple
interaction requests per node are unsupported. Context installation is
first-writer-wins: Node hosts needing async LangChain context initialize real
`AsyncLocalStorage` before the first `prepare`; the adapter preserves it.
The synchronous shim cannot provide implicit context after an await.

## Tests

Run `pnpm exec vitest run --project node packages/adapter-langgraph/test` for
[unit tests](test/), and `pnpm test tests/conformance/galaxie.test.ts` for Node
and Chromium parity. [Conformance guidance](../../tests/conformance/README.md)
lists explicit-config behavior. Use mocks, preserve all goldens and the
compatibility matrix, and run `pnpm check` before completion.
