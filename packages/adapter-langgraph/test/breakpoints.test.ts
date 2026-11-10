// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createRuntime, defineAgentDefinition, GalaxieError, toErrorInfo } from '@galaxie-ai/core';
import { Annotation, END, MemorySaver, START, StateGraph } from '@langchain/langgraph/web';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { createLangGraphAdapter } from '../src/adapter.js';
import type { LangGraphGraph } from '../src/host.js';

const refusal = {
  code: 'unsupported',
  message: 'The graph must not use compiled static breakpoints.',
};
const state = Annotation.Root({ value: Annotation<number> });

function prepare(graph: LangGraphGraph) {
  return createLangGraphAdapter().prepare(
    () => graph,
    { chatModels: {} },
    {
      signal: new AbortController().signal,
    },
  );
}

function facade(settings: object = {}): LangGraphGraph {
  return {
    stream: async () => ({ async *[Symbol.asyncIterator]() {} }),
    async *transform() {},
    getState: async () => ({ tasks: [] }),
    ...settings,
  };
}

test.each([
  { interruptBefore: ['secret_node' as const] },
  { interruptAfter: ['secret_node' as const] },
  { interruptBefore: ['secret_node' as const], interruptAfter: ['secret_node' as const] },
  { interruptBefore: '*' as const },
  { interruptAfter: '*' as const },
])('refuses compiled breakpoints before execution or checkpoint writes: %j', async (settings) => {
  let executions = 0;
  const saver = new MemorySaver();
  const graph = new StateGraph(state)
    .addNode('secret_node', () => {
      executions++;
      return {};
    })
    .addEdge(START, 'secret_node')
    .addEdge('secret_node', END)
    .compile({ checkpointer: saver, ...settings });
  const error = await prepare(graph).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(GalaxieError);
  expect(error).toMatchObject(refusal);
  expect(`${String(error)}${JSON.stringify(error)}`).not.toContain('secret_node');
  expect(executions).toBe(0);
  expect((await saver.list({}).next()).done).toBe(true);
});

test.each(['interruptBefore', 'interruptAfter'] as const)(
  'refuses set %s values on graph and config',
  async (key) => {
    for (const value of [['secret_node' as const], '*', false, 0, '', {}]) {
      await expect(prepare(facade({ [key]: value }))).rejects.toMatchObject(refusal);
      await expect(prepare(facade({ config: { [key]: value } }))).rejects.toMatchObject(refusal);
    }
  },
);

test.each([
  {},
  { interruptBefore: undefined },
  { interruptAfter: null },
  { interruptBefore: [], interruptAfter: [] },
])('accepts absent and empty settings and opaque facades: %j', async (settings) => {
  await expect(prepare(facade(settings))).resolves.toBeDefined();
  await expect(prepare(facade({ config: settings }))).resolves.toBeDefined();
});

test('refuses withConfig breakpoint overrides exposed on config', async () => {
  const graph = new StateGraph(state)
    .addNode('work', () => ({}))
    .addEdge(START, 'work')
    .addEdge('work', END)
    .compile()
    .withConfig({ interruptBefore: ['work'] });
  expect(graph.config).toMatchObject({ interruptBefore: ['work'] });
  await expect(prepare(graph)).rejects.toMatchObject(refusal);
});

test.each([1, 2])('refuses a discoverable compiled child at depth %i', async (depth) => {
  const child = new StateGraph(state)
    .addNode('secret_node', () => ({}))
    .addEdge(START, 'secret_node')
    .addEdge('secret_node', END)
    .compile({ interruptBefore: ['secret_node' as const] });
  const parent = new StateGraph(state)
    .addNode('child', child)
    .addEdge(START, 'child')
    .addEdge('child', END)
    .compile();
  const graph =
    depth === 1
      ? parent
      : new StateGraph(state)
          .addNode('parent', parent)
          .addEdge(START, 'parent')
          .addEdge('parent', END)
          .compile();
  await expect(prepare(graph)).rejects.toMatchObject(refusal);
});

test.each(['getSubgraphsAsync', 'getSubgraphs'] as const)(
  'inspects %s and refuses enumeration failures',
  async (key) => {
    await expect(
      prepare(
        facade({
          [key]: function* () {
            yield ['child', { config: { interruptAfter: '*' } }];
          },
        }),
      ),
    ).rejects.toMatchObject(refusal);
    await expect(
      prepare(
        facade({
          [key]: async function* () {
            yield ['child', {}];
            throw new Error('secret_node');
          },
        }),
      ),
    ).rejects.toMatchObject(refusal);
  },
);

test('prefers asynchronous subgraph discovery', async () => {
  await expect(
    prepare(
      facade({
        async *getSubgraphsAsync() {},
        getSubgraphs() {
          throw new Error('The deprecated enumerator must not run.');
        },
      }),
    ),
  ).resolves.toBeDefined();
});

test('runtime keeps prepare errors fixed and reports only the raw error to diagnostics', async () => {
  const diagnostics: unknown[] = [];
  const runtime = createRuntime({
    appId: 'tests',
    executors: [createLangGraphAdapter()],
    diagnostics: (event) => diagnostics.push(event),
  });
  try {
    const instance = await runtime.create(
      defineAgentDefinition({
        id: 'tests/breakpoints',
        version: '1.0.0',
        executor: 'langgraph-js',
        input: z.unknown(),
      }),
      {
        principalScope: 'tests',
        agent: () => facade({ interruptBefore: ['secret_node' as const] }),
      },
    );
    await expect(instance.prepare()).rejects.toMatchObject(toErrorInfo('unsupported'));
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ kind: 'prepare_failed', error: expect.objectContaining(refusal) }),
    );
    expect(instance.getSnapshot().run).toBeUndefined();
    await expect(instance.start({})).rejects.toMatchObject({ code: 'invalid' });
  } finally {
    await runtime.dispose();
  }
});
