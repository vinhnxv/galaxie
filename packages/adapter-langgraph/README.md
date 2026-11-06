# @galaxie/adapter-langgraph

A native LangGraph executor adapter for galaxie, using the browser `/web` entry,
checkpoint-backed pending interactions and interrupt-ID resume.

## Install

This is a private workspace package. With Node 24 and pnpm 11, run
`pnpm install --frozen-lockfile` and `pnpm build` at the repository root.
Workspace consumers use `@galaxie/adapter-langgraph: workspace:*`.
[package.json](package.json) records the LangChain and LangGraph peers.

## Minimal model-free graph

```ts
import { createLangGraphAdapter, type LangGraphAgent } from '@galaxie/adapter-langgraph';
import { createRuntime, defineAgentDefinition } from '@galaxie/core';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph/web';
import { z } from 'zod';

const state = Annotation.Root({ value: Annotation<number> });
const agent: LangGraphAgent = (host) => new StateGraph(state)
  .addNode('increment', ({ value }) => ({ value: value + 1 }))
  .addEdge(START, 'increment')
  .addEdge('increment', END)
  .compile({ checkpointer: host.langchain.checkpointer() });
const definition = defineAgentDefinition({
  id: 'docs/counter', version: '0.0.0', executor: 'langgraph-js',
  input: z.object({ value: z.number() }),
});
const runtime = createRuntime({ appId: 'counter-app', executors: [createLangGraphAdapter()] });
const instance = await runtime.create(definition, {
  principalScope: 'demo-learner', agent, services: { chatModels: {} },
});
await instance.prepare();
const { runId } = await instance.start({ value: 0 });
```

`start()` returns before execution finishes. Observe `instance.events(runId)`
and `instance.getSnapshot()`; keep the runtime alive until host teardown, then
`await runtime.dispose()`. Model nodes use `host.langchain.chatModel(role)` with
the node's explicit config. After an await, interactions use
`requestInteraction(request, config)`.

## Model-chosen capability tools

`host.langchain.capabilityTool(name: string, spec: CapabilityToolSpec)` returns a
LangChain `StructuredToolInterface`. The spec has `description`, a Standard Schema
`parameters` object (for example `z.object(...)`), and optional `toolName`. The
function name defaults to the capability name with punctuation replaced by `_`.
The capability must be declared by the agent and bound by the host.

```ts
const search = host.langchain.capabilityTool('docs.search@1', {
  description: 'Search the host document collection.',
  parameters: z.object({ query: z.string() }),
});
const model = host.langchain.chatModel('assistant').bindTools!([search]);
// Inside a node, forward its explicit config to the model and tools.
const reply = await model.invoke(history, config);
```

`bindTools(tools, kwargs?)` stores declarations on a routed runnable. Each call
requires `tool-calling` during provider selection and then calls the selected
provider's `bindTools`. A role with no provider that declares the feature fails
`unavailable`, as for structured output; a selected provider whose chat model
has no `bindTools` fails `unsupported`. Both fail before provider dispatch. An output-safety block on generated tool arguments fails
`denied` before the tools run. No alternate provider is tried after dispatch.

Execute the chosen calls with a native tool loop, for example
`new ToolNode([search], { handleToolErrors: false })` from
`@langchain/langgraph/prebuilt`, forwarding node config. The helper returns broker
`denied` and `invalid` failures as `{ error: <fixed message> }`, which LangChain
serializes into a `ToolMessage`; other failures propagate and must end the run.
Disable `ToolNode`'s general error handling as above so it does not turn fatal
broker failures into model observations.

Every call goes through the existing broker's labels, grants, validation,
budgets and effect IDs. The helper checks the host binding before offering a
write to a provider and before invoking it. A write binding must have
`approval: 'confirm'` and a configured host confirmation registry; otherwise the
call fails with fixed `invalid`. Only `instance.respond(id, 'approve')` approves
the broker's frozen real arguments. Model text or tool output cannot approve it.
Host code owns rendering the confirmation and authorizing backend operations.

With recovery, the forwarded full checkpoint namespace and deterministic
per-task call order preserve write receipts across resume, including concurrent
`ToolNode` calls. Without recovery, writes can repeat. Custom tools outside this
helper do not get its write-offering check; see the
[documented limits](../../docs/unsupported.md#execution-and-langgraph). Raw graph
streams and checkpoints can contain arguments and tool results and must not be
used as display data.

The added [tool-loop tests](../../tests/conformance/langgraph-tools.test.ts) target
Node and Chromium with deterministic mock models only. No real-model
tool-calling or injection-resistance result is claimed.

See [coding guidance](AGENTS.md), [explicit context rules and parity](../../tests/conformance/README.md)
and [runtime contracts](../../docs/system-design.md#6-core-runtime-and-contracts).
Parallel interrupts and static breakpoints remain unsupported.
Code is Apache-2.0 (see [LICENSE](../../LICENSE)).
