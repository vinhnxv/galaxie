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

See [coding guidance](AGENTS.md), [explicit context rules and parity](../../tests/conformance/README.md)
and [runtime contracts](../../docs/system-design.md#6-core-runtime-and-contracts).
Parallel interrupts and static breakpoints remain unsupported.
Code is Apache-2.0 (see [LICENSE](../../LICENSE)).
