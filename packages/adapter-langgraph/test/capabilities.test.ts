// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import {
  type BudgetLimits,
  type CapabilityBinding,
  type CapabilityRequests,
  createRuntime,
  defineAgentDefinition,
  GalaxieError,
  galaxieField,
} from '@galaxie/core';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph/web';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { binding, collect, deferred } from '../../core/test/fake-executor.js';
import { assertSpanTree, createSpanRecorder, serializeSpans } from '../../core/test/span-tree.js';
import { createLangGraphAdapter } from '../src/adapter.js';
import type { LangGraphAgent, LangGraphHost } from '../src/host.js';

const state = Annotation.Root({ value: Annotation<number>, note: Annotation<string> });
const requests: CapabilityRequests = {
  'echo@1': {
    input: z.string(),
    output: z.string().meta(galaxieField({ label: 'private-user' })),
    kind: 'read',
  },
  'unbound@1': { input: z.string(), output: z.string(), kind: 'read' },
};
const definition = defineAgentDefinition({
  id: 'adapter/capabilities',
  version: '1.0.0',
  executor: 'langgraph-js',
  input: z.object({
    value: z.number(),
    note: z
      .string()
      .optional()
      .meta(galaxieField({ label: 'private-user' })),
  }),
  capabilities: { optional: requests },
});
async function ready(
  agent: LangGraphAgent,
  options: {
    readonly budgets?: Partial<BudgetLimits>;
    readonly bound?: CapabilityBinding;
  } = {},
) {
  const { exporter, provider } = createSpanRecorder();
  const runtime = createRuntime({
    appId: 'adapter-tests',
    executors: [createLangGraphAdapter()],
    tracerProvider: provider,
    ...(options.budgets === undefined ? {} : { budgets: options.budgets }),
  });
  let captured: LangGraphHost | undefined;
  const instance = await runtime.create(definition, {
    principalScope: 'user',
    bindings: { 'echo@1': options.bound ?? binding() },
    agent: (host) => {
      captured = host;
      return agent(host);
    },
  });
  await instance.prepare();
  if (captured === undefined) throw new Error('The graph factory did not receive a host.');
  return { runtime, instance, exporter, provider, host: captured };
}

test.each(['manager', 'none', 'array'] as const)(
  'a real node capability parents through config=%s',
  async (configMode) => {
    const fixture = await ready((host) =>
      new StateGraph(state)
        .addNode('lookup', async ({ value }, config) => {
          await host.capabilities.call(
            'echo@1',
            'query',
            configMode === 'manager'
              ? config
              : configMode === 'array'
                ? { ...config, callbacks: [] }
                : undefined,
          );
          return { value: value + 1 };
        })
        .addEdge(START, 'lookup')
        .addEdge('lookup', END)
        .compile(),
    );
    const run = await fixture.instance.start({ value: 0 });
    expect((await collect(fixture.instance.events(run.runId))).at(-1)).toMatchObject({
      type: 'output',
      output: { value: 1 },
    });
    await fixture.runtime.dispose();
    const spans = fixture.exporter.getFinishedSpans();
    assertSpanTree(spans);
    const capability = spans.find((span) => span.name === 'execute_tool echo@1');
    const node = spans.find((span) => span.name === 'galaxie.node lookup');
    const root = spans.find((span) => span.name === 'invoke_agent adapter/capabilities');
    expect(capability?.parentSpanContext?.spanId).toBe(
      (configMode === 'manager' ? node : root)?.spanContext().spanId,
    );
    await fixture.provider.shutdown();
  },
);
test('host capability access before and after an active run rejects invalid', async () => {
  const fixture = await ready(() =>
    new StateGraph(state)
      .addNode('finish', () => ({}))
      .addEdge(START, 'finish')
      .addEdge('finish', END)
      .compile(),
  );
  await expect(fixture.host.capabilities.call('echo@1', 'query')).rejects.toMatchObject({
    code: 'invalid',
  });
  const run = await fixture.instance.start({ value: 0 });
  await collect(fixture.instance.events(run.runId));
  await fixture.runtime.dispose();
  await expect(fixture.host.capabilities.call('echo@1', 'query')).rejects.toMatchObject({
    code: 'invalid',
  });
  await fixture.provider.shutdown();
});
test('a caught denied call preserves the code, omits cause and lets the graph continue', async () => {
  let caught: unknown;
  const fixture = await ready((host) =>
    new StateGraph(state)
      .addNode('lookup', async ({ value }, config) => {
        try {
          await host.capabilities.call('unbound@1', 'canary-argument', config);
        } catch (error) {
          caught = error;
        }
        return { value: value + 1 };
      })
      .addEdge(START, 'lookup')
      .addEdge('lookup', END)
      .compile(),
  );
  const run = await fixture.instance.start({ value: 0 });
  expect((await collect(fixture.instance.events(run.runId))).at(-1)).toMatchObject({
    type: 'output',
    output: { value: 1 },
  });
  await fixture.runtime.dispose();
  expect(caught).toBeInstanceOf(GalaxieError);
  expect(caught).toMatchObject({ code: 'denied', message: 'Policy denied the request.' });
  expect(caught).not.toHaveProperty('cause');
  await fixture.provider.shutdown();
});
test('an uncaught capability denial fails the real graph with denied', async () => {
  const fixture = await ready((host) =>
    new StateGraph(state)
      .addNode('lookup', async (_value, config) => {
        await host.capabilities.call('unbound@1', 'query', config);
        return {};
      })
      .addEdge(START, 'lookup')
      .addEdge('lookup', END)
      .compile(),
  );
  const run = await fixture.instance.start({ value: 0 });
  const events = await collect(fixture.instance.events(run.runId));
  await fixture.runtime.dispose();
  expect(events.at(-1)).toMatchObject({
    type: 'error',
    error: { code: 'denied', type: 'GalaxieError' },
  });
  expect(fixture.instance.getSnapshot().run?.error?.code).toBe('denied');
  await fixture.provider.shutdown();
});
test.each(['budget', 'graph'] as const)(
  '%s recursion limit stops the native engine at three steps',
  async (source) => {
    let visits = 0;
    const fixture = await ready(
      () => {
        const graph = new StateGraph(state)
          .addNode('loop', ({ value }) => {
            visits++;
            return { value: value + 1 };
          })
          .addEdge(START, 'loop')
          .addEdge('loop', 'loop')
          .compile();
        return source === 'graph' ? graph.withConfig({ recursionLimit: 3 }) : graph;
      },
      source === 'budget' ? { budgets: { steps: 3 } } : {},
    );
    const run = await fixture.instance.start({ value: 0 });
    const events = await collect(fixture.instance.events(run.runId));
    await fixture.runtime.dispose();
    expect(visits).toBe(3);
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      error: { code: 'budget_exceeded', type: 'GraphRecursionError' },
    });
    expect(fixture.instance.getSnapshot().run).toMatchObject({
      status: 'failed',
      error: { code: 'budget_exceeded' },
    });
    const spans = fixture.exporter.getFinishedSpans();
    assertSpanTree(spans);
    expect(spans.find((span) => span.name.startsWith('invoke_agent'))?.attributes).toMatchObject({
      'galaxie.budget.name': 'steps',
      'galaxie.error.code': 'budget_exceeded',
    });
    await fixture.provider.shutdown();
  },
);
test('config.signal cancellation reaches the binding and can be caught in a node', async () => {
  const entered = deferred<void>();
  const release = deferred<unknown>();
  const caller = new AbortController();
  let signal: AbortSignal | undefined;
  let caught: unknown;
  const fixture = await ready(
    (host) =>
      new StateGraph(state)
        .addNode('lookup', async (_value, config) => {
          try {
            await host.capabilities.call('echo@1', 'query', { ...config, signal: caller.signal });
          } catch (error) {
            caught = error;
          }
          return {};
        })
        .addEdge(START, 'lookup')
        .addEdge('lookup', END)
        .compile(),
    {
      bound: binding({
        invoke: (_input, context) => {
          signal = context.signal;
          entered.resolve();
          return release.promise;
        },
      }),
    },
  );
  const run = await fixture.instance.start({ value: 0 });
  await entered.promise;
  caller.abort();
  await collect(fixture.instance.events(run.runId));
  release.resolve('late');
  await fixture.runtime.dispose();
  expect(signal?.aborted).toBe(true);
  expect(caught).toMatchObject({ code: 'cancelled' });
  expect(fixture.instance.getSnapshot().run?.status).toBe('succeeded');
  await fixture.provider.shutdown();
});
test('real graph canaries stay out of spans, error events, run errors, labels and graph-facing errors', async () => {
  let caught: unknown;
  const fixture = await ready(
    (host) =>
      new StateGraph(state)
        .addNode('lookup', async (_value, config) => {
          await host.capabilities.call('echo@1', 'canary-argument', config);
          try {
            await host.capabilities.call('unbound@1', 'canary-private-output', config);
          } catch (error) {
            caught = error;
            throw error;
          }
          return {};
        })
        .addEdge(START, 'lookup')
        .addEdge('lookup', END)
        .compile(),
    { bound: binding({ invoke: async () => 'canary-private-output' }) },
  );
  const run = await fixture.instance.start({ value: 0, note: 'canary-private-input' });
  const events = await collect(fixture.instance.events(run.runId));
  await fixture.runtime.dispose();
  const spans = fixture.exporter.getFinishedSpans();
  assertSpanTree(spans);
  const fields =
    JSON.stringify({
      errors: events.filter((event) => event.type === 'error'),
      run: fixture.instance.getSnapshot().run,
      caught,
    }) + serializeSpans(spans);
  for (const canary of ['canary-private-input', 'canary-private-output', 'canary-argument'])
    expect(fields).not.toContain(canary);
  expect(caught).toBeInstanceOf(GalaxieError);
  expect(caught).not.toHaveProperty('cause');
  await fixture.provider.shutdown();
});

test('a known GalaxieError cause retains its code through a graph wrapper error', async () => {
  const fixture = await ready(() =>
    new StateGraph(state)
      .addNode('wrapped', () => {
        throw new Error('canary-wrapper-message', {
          cause: new GalaxieError('denied', 'canary-cause-message'),
        });
      })
      .addEdge(START, 'wrapped')
      .addEdge('wrapped', END)
      .compile(),
  );
  const run = await fixture.instance.start({ value: 0 });
  const events = await collect(fixture.instance.events(run.runId));
  await fixture.runtime.dispose();
  expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'denied', type: 'Error' } });
  expect(JSON.stringify(events.filter((event) => event.type === 'error'))).not.toContain('canary');
  await fixture.provider.shutdown();
});
