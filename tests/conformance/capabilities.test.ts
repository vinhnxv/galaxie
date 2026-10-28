// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { createLangGraphAdapter } from '@galaxie/adapter-langgraph';
import { createRuntime, defineAgentDefinition, GalaxieError, httpCapability } from '@galaxie/core';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph/web';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { binding, collect } from '../../packages/core/test/fake-executor.js';

test('classic Zod exposes Standard JSON Schema in this runtime', () => {
  const standard = z.string()['~standard'].jsonSchema;
  expect(typeof standard?.input).toBe('function');
  expect(typeof standard?.output).toBe('function');
});
test('a real graph calls bound capabilities, denies an unbound call and attributes HTTP in Node and Chromium', async () => {
  const requests: Array<{ url: string; headers: Headers }> = [];
  const runtime = createRuntime({
    appId: 'shared-capabilities',
    executors: [createLangGraphAdapter()],
  });
  const text = { input: z.string(), output: z.string(), kind: 'read' as const };
  const definition = defineAgentDefinition({
    id: 'conformance/capabilities',
    version: '1.0.0',
    executor: 'langgraph-js',
    input: z.object({}),
    capabilities: {
      optional: {
        'bound@1': text,
        'unbound@1': text,
        'lessons.get@1': {
          input: z.object({ id: z.enum(['lesson-1']) }),
          output: z.object({ title: z.string() }),
          kind: 'read',
        },
      },
    },
  });
  let denied: unknown;
  const instance = await runtime.create(definition, {
    principalScope: 'user',
    bindings: {
      'bound@1': { ...binding(), invoke: async () => 'bound result' },
      'lessons.get@1': httpCapability<{ id: 'lesson-1' }, { title: string }>({
        ...binding(),
        destination: 'host-server',
        url: 'https://api.example.test/lessons/{id}',
        method: 'GET',
        fetch: async (url, init) => {
          requests.push({ url: String(url), headers: new Headers(init?.headers) });
          return Response.json({ title: 'lesson title' });
        },
      }),
    },
    agent: (host) => {
      const state = Annotation.Root({ answer: Annotation<string> });
      return new StateGraph(state)
        .addNode('lookup', async (_state, config) => {
          const result = await host.capabilities.call('bound@1', 'query', config);
          try {
            await host.capabilities.call('unbound@1', 'query', config);
          } catch (error) {
            denied = error;
          }
          const lesson = (await host.capabilities.call(
            'lessons.get@1',
            { id: 'lesson-1' },
            config,
          )) as { title: string };
          return { answer: `${String(result)}: ${lesson.title}` };
        })
        .addEdge(START, 'lookup')
        .addEdge('lookup', END)
        .compile();
    },
  });
  try {
    await instance.prepare();
    const { runId } = await instance.start({});
    expect((await collect(instance.events(runId))).at(-1)).toMatchObject({
      type: 'output',
      output: { answer: 'bound result: lesson title' },
    });
    expect(denied).toBeInstanceOf(GalaxieError);
    expect(denied).toMatchObject({ code: 'denied' });
    expect(denied).not.toHaveProperty('cause');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://api.example.test/lessons/lesson-1');
    expect(requests[0]?.headers.get('x-galaxie-agent')).toBe('conformance/capabilities@1.0.0');
    expect(requests[0]?.headers.get('x-galaxie-run')).toBe(runId);
  } finally {
    await runtime.dispose();
  }
});
