// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { createLangGraphAdapter, requestInteraction } from '@galaxie/adapter-langgraph';
import {
  createRuntime,
  type DataLabel,
  type DataPolicy,
  type DestinationClass,
  type DiagnosticEvent,
  defineAgentDefinition,
  galaxieField,
} from '@galaxie/core';
import { MockChatModel } from '@galaxie/models/mock';
import type { BaseChatModel, LangSmithParams } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import * as web from '@langchain/langgraph/web';
import { SpanStatusCode } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { binding, collect } from '../../packages/core/test/fake-executor.js';
import { assertSpanTree, serializeSpans } from '../../packages/core/test/span-tree.js';
import { cases } from './cases/index.js';
import { assistantRoles, assistantRouting } from './support/routing.js';
import { FixtureModelError, ScriptedChatModel } from './support/scripted-chat-model.js';
import type { ConformanceCase } from './support/transcript.js';

const definition = defineAgentDefinition({
  id: 'conformance/graph',
  version: '1.0.0',
  executor: 'langgraph-js',
  input: z.unknown(),
  models: assistantRoles,
});

async function ready(
  fixture: ConformanceCase,
  model: BaseChatModel = new ScriptedChatModel(fixture.script),
  diagnostics?: (event: DiagnosticEvent) => void,
) {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  const runtime = createRuntime({
    appId: 'conformance',
    executors: [createLangGraphAdapter()],
    tracerProvider: provider,
    ...(diagnostics === undefined ? {} : { diagnostics }),
  });
  const instance = await runtime.create(definition, {
    principalScope: 'canary-principal',
    models: assistantRouting(),
    services: { chatModels: { assistant: model } },
    agent: (host) =>
      fixture.factory(web, host.langchain.chatModel('assistant'), host.langchain.checkpointer()),
  });
  await instance.prepare();
  return { runtime, instance, exporter, provider };
}

test('linear has one allowlisted run, node and model tree with provider and usage', async () => {
  const fixture = cases.linear;
  const { runtime, instance, exporter, provider } = await ready(fixture);
  try {
    const { runId } = await instance.start({ value: 2, private: 'canary-input' });
    const events = await collect(instance.events(runId));
    expect(events.at(-1)).toMatchObject({
      type: 'output',
      output: { value: 6, answer: 'linear response' },
    });
    await runtime.dispose();
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    expect(assertSpanTree(spans)).toEqual({
      name: 'invoke_agent conformance/graph',
      children: [
        { name: 'galaxie.node double', children: [] },
        { name: 'galaxie.node respond', children: [{ name: 'chat fixture-1', children: [] }] },
      ],
    });
    expect(new Set(spans.map((span) => span.spanContext().traceId)).size).toBe(1);
    expect(
      spans.find(({ name }) => name === 'invoke_agent conformance/graph')?.parentSpanContext,
    ).toBeUndefined();
    expect(spans.find(({ name }) => name === 'chat fixture-1')?.attributes).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'galaxie-fixture',
      'gen_ai.request.model': 'fixture-1',
      'gen_ai.usage.input_tokens': 2,
      'gen_ai.usage.output_tokens': 2,
      'galaxie.step.status': 'ok',
    });
    expect(serializeSpans(spans)).not.toMatch(
      /canary-input|canary-principal|linear request|linear response/,
    );
  } finally {
    await runtime.dispose();
    await provider.shutdown();
  }
});

test('model failure ends the model, node and run with ERROR and exposes the raw canary only to diagnostics', async () => {
  const raw = new FixtureModelError('canary-error credentials=canary-credential');
  const model = new ScriptedChatModel({ 'failure request': { error: raw } });
  const diagnostics: DiagnosticEvent[] = [];
  const fixture = cases['model-failure'];
  const { runtime, instance, exporter, provider } = await ready(fixture, model, (event) => {
    diagnostics.push(event);
  });
  try {
    const { runId } = await instance.start(fixture.input);
    const events = await collect(instance.events(runId));
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      error: {
        code: 'executor_error',
        type: 'FixtureModelError',
        message: 'The executor or agent code failed.',
      },
    });
    expect(instance.getSnapshot().run?.status).toBe('failed');
    expect(diagnostics.find(({ kind }) => kind === 'run_failed')?.error).toBe(raw);
    await runtime.dispose();
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    expect(assertSpanTree(spans)).toEqual({
      name: 'invoke_agent conformance/graph',
      children: [
        { name: 'galaxie.node fail', children: [{ name: 'chat fixture-1', children: [] }] },
      ],
    });
    for (const span of spans) {
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.attributes['error.type']).toBe('FixtureModelError');
      expect(span.attributes['galaxie.error.code']).toBe(
        span.name === 'invoke_agent conformance/graph' ? 'executor_error' : undefined,
      );
    }
    expect(
      JSON.stringify({ snapshot: instance.getSnapshot(), events }) + serializeSpans(spans),
    ).not.toMatch(/canary-error|canary-credential|canary-principal|failure request/);
  } finally {
    await runtime.dispose();
    await provider.shutdown();
  }
});

class CanaryModel extends ScriptedChatModel {
  override getLsParams(): LangSmithParams {
    return { ...super.getLsParams(), ls_model_name: 'canary-model-x\n' };
  }
}

test('a control character model name is replaced before entering spans', async () => {
  const fixture = cases.linear;
  const { runtime, instance, exporter, provider } = await ready(
    fixture,
    new CanaryModel(fixture.script),
  );
  try {
    const { runId } = await instance.start(fixture.input);
    expect((await collect(instance.events(runId))).at(-1)?.type).toBe('output');
    await runtime.dispose();
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    assertSpanTree(spans);
    expect(spans.find(({ name }) => name === 'chat _OTHER')?.attributes).toMatchObject({
      'gen_ai.request.model': '_OTHER',
    });
    expect(serializeSpans(spans)).not.toContain('canary-model-x');
  } finally {
    await runtime.dispose();
    await provider.shutdown();
  }
});

test('a model without forwarded config has a node span and no implicit model span', async () => {
  const fixture = cases['model-without-config'];
  const { runtime, instance, exporter, provider } = await ready(fixture);
  try {
    const { runId } = await instance.start(fixture.input);
    expect((await collect(instance.events(runId))).at(-1)?.type).toBe('output');
    await runtime.dispose();
    await provider.forceFlush();
    expect(assertSpanTree(exporter.getFinishedSpans())).toEqual({
      name: 'invoke_agent conformance/graph',
      children: [{ name: 'galaxie.node implicit', children: [] }],
    });
  } finally {
    await runtime.dispose();
    await provider.shutdown();
  }
});

const traceTextKeys = [
  'gen_ai.input.messages',
  'gen_ai.output.messages',
  'gen_ai.tool.call.arguments',
];
const tracePrompt = `development prompt\n${'long text '.repeat(20)}`;
const traceReply = `development reply\n${'long reply '.repeat(20)}`;
const traceArguments = { query: 'development capability argument' };

async function textScenario(
  options: {
    label?: DataLabel;
    destination?: DestinationClass;
    outputLabel?: DataLabel;
    secondModel?: boolean;
    resume?: boolean;
    submission?: unknown;
    rejected?: 'invalid' | 'policy' | 'payload';
    policy?: DataPolicy;
  } = {},
) {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  const runtime = createRuntime({
    appId: 'trace-text',
    executors: [createLangGraphAdapter()],
    tracerProvider: provider,
    ...(options.destination === undefined
      ? {}
      : { developmentTraceText: { destination: options.destination } }),
    ...(options.policy === undefined ? {} : { dataPolicy: options.policy }),
    ...(options.rejected === 'payload' ? { budgets: { payloadBytes: 8 } } : {}),
  });
  const agentDefinition = defineAgentDefinition({
    id: 'conformance/trace-text',
    version: '1.0.0',
    executor: 'langgraph-js',
    input: z.object({ value: z.string().meta(galaxieField({ label: options.label ?? 'public' })) }),
    models: assistantRoles,
    capabilities: {
      optional: {
        'lookup@1': {
          input: z.object({ query: z.string() }),
          output: z.object({
            result: z.string().meta(galaxieField({ label: options.outputLabel ?? 'public' })),
          }),
          kind: 'read',
        },
      },
    },
  });
  let invoked = 0;
  const instance = await runtime.create(agentDefinition, {
    principalScope: 'fixture',
    models: assistantRouting(),
    services: {
      chatModels: {
        assistant: new ScriptedChatModel({
          [tracePrompt]: {
            id: 'trace-reply',
            text: traceReply,
            usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
          },
        }),
      },
    },
    bindings: {
      'lookup@1': {
        ...binding({ destination: options.rejected === 'policy' ? 'third-party' : 'in-browser' }),
        invoke: async () => {
          invoked++;
          return { result: 'capability result' };
        },
      },
    },
    agent: (host) => {
      const state = web.Annotation.Root({ value: web.Annotation<string> });
      const model = host.langchain.chatModel('assistant');
      return new web.StateGraph(state)
        .addNode('a', async (_state, config) => {
          await model.invoke(
            [
              new SystemMessage({ content: [{ type: 'text', text: 'structured system' }] }),
              new AIMessage({ content: 'previous answer' }),
              new ToolMessage({ content: 'tool result', tool_call_id: 'tool-1' }),
              new HumanMessage({ content: tracePrompt }),
            ],
            config,
          );
          return {};
        })
        .addNode('b', async (_state, config) => {
          const call = host.capabilities.call(
            'lookup@1',
            options.rejected === 'invalid' ? { query: 1 } : traceArguments,
            config,
          );
          if (options.rejected !== undefined) {
            await expect(call).rejects.toMatchObject({
              code:
                options.rejected === 'invalid'
                  ? 'invalid'
                  : options.rejected === 'policy'
                    ? 'denied'
                    : 'budget_exceeded',
            });
          } else await call;
          return {};
        })
        .addNode('ask', async (_state, config) => {
          if (options.resume)
            requestInteraction(
              {
                surfaceId: 'main',
                viewRevision: 'r1',
                component: 'conformance.Question/v1',
                props: { question: 'Continue?' },
              },
              config,
            );
          return {};
        })
        .addNode('c', async (_state, config) => {
          if (options.secondModel || options.resume)
            await model.invoke([new HumanMessage({ content: tracePrompt })], config);
          return {};
        })
        .addEdge(web.START, 'a')
        .addEdge('a', 'b')
        .addEdge('b', 'ask')
        .addEdge('ask', 'c')
        .addEdge('c', web.END)
        .compile({ checkpointer: host.langchain.checkpointer() });
    },
  });
  try {
    await instance.prepare();
    const { runId } = await instance.start({ value: 'input' });
    if (options.resume) {
      for await (const event of instance.events(runId)) if (event.type === 'interaction') break;
    } else await collect(instance.events(runId));
    if (options.resume) {
      const pending = instance.getSnapshot().run?.pending;
      expect(pending).toBeDefined();
      if (pending === undefined) throw new Error('The interaction is missing.');
      expect(
        await instance.dispatch({
          ...pending,
          instanceId: instance.getSnapshot().instanceId,
          runId,
          action: 'submit',
          payload: options.submission ?? false,
        }),
      ).toMatchObject({ status: 'accepted' });
      await collect(instance.events(runId));
    }
    expect(instance.getSnapshot().run?.status).toBe(
      options.rejected === 'payload' ? 'failed' : 'succeeded',
    );
    await runtime.dispose();
    await provider.forceFlush();
    return { spans: exporter.getFinishedSpans(), invoked };
  } finally {
    await runtime.dispose();
    await provider.shutdown();
  }
}

function withoutText(spans: ReturnType<InMemorySpanExporter['getFinishedSpans']>) {
  return spans.map((span) => ({
    name: span.name,
    kind: span.kind,
    status: span.status,
    attributes: Object.fromEntries(
      Object.entries(span.attributes).filter(
        ([key]) =>
          !traceTextKeys.includes(key) &&
          ![
            'galaxie.instance.id',
            'galaxie.session.id',
            'galaxie.run.id',
            'galaxie.run.labels',
          ].includes(key),
      ),
    ),
  }));
}

function expectNoText(spans: ReturnType<InMemorySpanExporter['getFinishedSpans']>) {
  for (const span of spans)
    for (const key of traceTextKeys)
      expect(span.attributes[key], `${span.name}: ${key}`).toBeUndefined();
}

test('development trace text requires opt-in and a label-allowed destination', async () => {
  const absent = await textScenario();
  assertSpanTree(absent.spans);
  expectNoText(absent.spans);
  const publicRun = await textScenario({ destination: 'third-party' });
  assertSpanTree(publicRun.spans, { text: 'allowed' });
  const model = publicRun.spans.find((span) => span.name.startsWith('chat'));
  expect(JSON.parse(String(model?.attributes['gen_ai.input.messages']))).toEqual([
    {
      role: 'system',
      parts: [{ type: 'text', content: '[{"type":"text","text":"structured system"}]' }],
    },
    { role: 'assistant', parts: [{ type: 'text', content: 'previous answer' }] },
    { role: 'tool', parts: [{ type: 'text', content: 'tool result' }] },
    { role: 'user', parts: [{ type: 'text', content: tracePrompt }] },
  ]);
  expect(JSON.parse(String(model?.attributes['gen_ai.output.messages']))).toEqual([
    { role: 'assistant', parts: [{ type: 'text', content: traceReply }], finish_reason: 'stop' },
  ]);
  expect(
    publicRun.spans.find((span) => span.name === 'execute_tool lookup@1')?.attributes[
      'gen_ai.tool.call.arguments'
    ],
  ).toBe(JSON.stringify(traceArguments));
  const appRun = await textScenario({ label: 'app', destination: 'third-party' });
  expectNoText(appRun.spans);
  expect(withoutText(appRun.spans)).toEqual(withoutText(publicRun.spans));
  const hostRun = await textScenario({ label: 'app', destination: 'host-server' });
  expect(
    hostRun.spans.find((span) => span.name.startsWith('chat'))?.attributes['gen_ai.input.messages'],
  ).toBeDefined();
});

test.each(['in-browser', 'user-device', 'user-endpoint', 'host-server', 'third-party'] as const)(
  'private input never records trace text for %s',
  async (destination) => {
    const { spans } = await textScenario({ label: 'private-user', destination });
    expectNoText(spans);
  },
);

test('browser-only host policy blocks trace text even for an in-browser destination', async () => {
  const { spans } = await textScenario({
    label: 'app',
    destination: 'in-browser',
    policy: { app: { allow: ['in-browser'] } },
  });
  expectNoText(spans);
});

test('trace text decisions read labels added between model calls', async () => {
  const { spans } = await textScenario({
    destination: 'third-party',
    outputLabel: 'app',
    secondModel: true,
  });
  const models = spans.filter((span) => span.name.startsWith('chat'));
  expect(models).toHaveLength(2);
  expect(models[0]?.attributes['gen_ai.input.messages']).toBeDefined();
  expect(models[0]?.attributes['gen_ai.output.messages']).toBeDefined();
  expect(models[1]?.attributes['gen_ai.input.messages']).toBeUndefined();
  expect(models[1]?.attributes['gen_ai.output.messages']).toBeUndefined();
});

test('trace text keeps private capability labels across a resumed segment', async () => {
  const { spans } = await textScenario({
    destination: 'in-browser',
    outputLabel: 'private-user',
    resume: true,
  });
  const models = spans.filter((span) => span.name.startsWith('chat'));
  expect(models).toHaveLength(2);
  expect(models[0]?.attributes['gen_ai.input.messages']).toBeDefined();
  expect(models[1]?.attributes['gen_ai.input.messages']).toBeUndefined();
  expect(models[1]?.attributes['gen_ai.output.messages']).toBeUndefined();
});

test.each([
  ['nested string', { nested: [false, { answer: 'free text' }] }, false],
  ['no string', { nested: [false, { answer: '' }] }, true],
] as const)(
  'accepted submission %s controls resumed trace text',
  async (_name, submission, records) => {
    const { spans } = await textScenario({ destination: 'third-party', resume: true, submission });
    const models = spans.filter((span) => span.name.startsWith('chat'));
    expect(models).toHaveLength(2);
    expect(models[0]?.attributes['gen_ai.input.messages']).toBeDefined();
    expect(models[1]?.attributes['gen_ai.input.messages'] !== undefined).toBe(records);
    expect(models[1]?.attributes['gen_ai.output.messages'] !== undefined).toBe(records);
  },
);

test.each(['invalid', 'policy', 'payload'] as const)(
  'capability %s rejection never records arguments',
  async (rejected) => {
    const { spans, invoked } = await textScenario({
      label: 'app',
      destination: 'host-server',
      rejected,
    });
    expect(invoked).toBe(0);
    expect(
      spans.find((span) => span.name === 'execute_tool lookup@1')?.attributes[
        'gen_ai.tool.call.arguments'
      ],
    ).toBeUndefined();
  },
);

test('queued capability arguments wait for the second policy check', async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  const runtime = createRuntime({
    appId: 'queued-trace-text',
    executors: [createLangGraphAdapter()],
    tracerProvider: provider,
    developmentTraceText: { destination: 'host-server' },
  });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  const instance = await runtime.create(
    defineAgentDefinition({
      id: 'conformance/queued-trace-text',
      version: '1.0.0',
      executor: 'langgraph-js',
      input: z.object({ value: z.string().meta(galaxieField({ label: 'public' })) }),
      capabilities: {
        optional: {
          'lookup@1': {
            input: z.object({ query: z.string() }),
            output: z.string().meta(galaxieField({ label: 'app' })),
            kind: 'read',
          },
        },
      },
    }),
    {
      principalScope: 'fixture',
      bindings: {
        'lookup@1': {
          ...binding({ destination: 'third-party' }),
          invoke: async () => {
            calls++;
            entered.resolve();
            await release.promise;
            return 'app output';
          },
        },
      },
      agent: (host) => {
        const state = web.Annotation.Root({ value: web.Annotation<string> });
        return new web.StateGraph(state)
          .addNode('queued', async (_state, config) => {
            const first = host.capabilities.call('lookup@1', { query: 'first' }, config);
            await entered.promise;
            const second = host.capabilities.call(
              'lookup@1',
              { query: 'denied queued argument' },
              config,
            );
            const rejected = expect(second).rejects.toMatchObject({ code: 'denied' });
            // Let validation and the first policy check finish while the first call holds the slot.
            await new Promise((resolve) => setTimeout(resolve, 0));
            release.resolve();
            await first;
            await rejected;
            return {};
          })
          .addEdge(web.START, 'queued')
          .addEdge('queued', web.END)
          .compile();
      },
    },
  );
  try {
    await instance.prepare();
    const { runId } = await instance.start({ value: 'public input' });
    expect((await collect(instance.events(runId))).at(-1)?.type).toBe('output');
    await runtime.dispose();
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    assertSpanTree(spans, { text: 'allowed' });
    expect(calls).toBe(1);
    const capabilities = spans.filter((span) => span.name === 'execute_tool lookup@1');
    expect(capabilities).toHaveLength(2);
    expect(
      capabilities.find((span) => span.attributes['galaxie.step.status'] === 'ok')?.attributes[
        'gen_ai.tool.call.arguments'
      ],
    ).toBe('{"query":"first"}');
    expect(
      capabilities.find((span) => span.attributes['galaxie.error.code'] === 'denied')?.attributes[
        'gen_ai.tool.call.arguments'
      ],
    ).toBeUndefined();
    expect(serializeSpans(spans)).not.toContain('denied queued argument');
  } finally {
    release.resolve();
    await runtime.dispose();
    await provider.shutdown();
  }
});

const treeCredential = 'at36-credential-canary';
const treeError = 'at36-error-message-canary';
const treePrompt = 'at36 model input';

async function completeSpanTree(failed: boolean, text: boolean) {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  const credentials: string[] = [];
  const getCredential = (): string => treeCredential;
  const runtime = createRuntime({
    appId: 'complete-span-tree',
    executors: [createLangGraphAdapter()],
    tracerProvider: provider,
    ...(text ? { developmentTraceText: { destination: 'third-party' as const } } : {}),
  });
  const model = new MockChatModel({
    [treePrompt]: failed
      ? { error: new Error(treeError) }
      : {
          id: 'at36-reply',
          text: 'at36 model output',
          usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
        },
  });
  const instance = await runtime.create(
    defineAgentDefinition({
      id: 'conformance/complete-tree',
      version: '1.0.0',
      executor: 'langgraph-js',
      input: z.object({ value: z.string().meta(galaxieField({ label: 'public' })) }),
      models: assistantRoles,
      capabilities: {
        optional: {
          'lookup@1': {
            input: z.object({ query: z.string() }),
            output: z.string().meta(galaxieField({ label: 'public' })),
            kind: 'read',
          },
        },
      },
    }),
    {
      principalScope: 'fixture',
      models: {
        providers: {
          assistant: {
            destination: 'host-server',
            modality: 'text',
            features: ['streaming', 'cancellation'],
            pricing: { inputPerToken: 0, outputPerToken: 0 },
            credential: true,
          },
        },
        roles: { assistant: { providers: ['assistant'], allow: ['host-server'], maxTokens: 1000 } },
        consent: () => true,
        getCredential,
      },
      services: {
        chatModels: {
          assistant: ({ credential }) => {
            credentials.push(credential);
            return model;
          },
        },
      },
      bindings: {
        'lookup@1': {
          ...binding(),
          invoke: async () => {
            credentials.push(getCredential());
            if (failed) throw new Error(treeError);
            return 'at36 capability output';
          },
        },
      },
      agent: (host) => {
        const state = web.Annotation.Root({ value: web.Annotation<string> });
        return new web.StateGraph(state)
          .addNode('a', async (_state, config) => {
            try {
              await host.langchain
                .chatModel('assistant')
                .invoke([new HumanMessage({ content: treePrompt })], config);
            } catch (error) {
              if (!failed) throw error;
            }
            return {};
          })
          .addNode('b', async (_state, config) => {
            await host.capabilities.call('lookup@1', { query: 'at36 capability argument' }, config);
            return {};
          })
          .addEdge(web.START, 'a')
          .addEdge('a', 'b')
          .addEdge('b', web.END)
          .compile();
      },
    },
  );
  try {
    await instance.prepare();
    const { runId } = await instance.start({ value: 'public input' });
    const events = await collect(instance.events(runId));
    const snapshot = instance.getSnapshot();
    await runtime.dispose();
    await provider.forceFlush();
    expect(credentials).toEqual([treeCredential, treeCredential]);
    expect(model.calls).toBe(1);
    expect(snapshot.run?.status).toBe(failed ? 'failed' : 'succeeded');
    return { spans: exporter.getFinishedSpans(), snapshot, events };
  } finally {
    await runtime.dispose();
    await provider.shutdown();
  }
}

test('AT-36 one real graph contains run, node, routed model and capability spans in one tree', async () => {
  const { spans } = await completeSpanTree(false, false);
  expect(assertSpanTree(spans)).toEqual({
    name: 'invoke_agent conformance/complete-tree',
    children: [
      { name: 'galaxie.node a', children: [{ name: 'chat mock-1', children: [] }] },
      { name: 'galaxie.node b', children: [{ name: 'execute_tool lookup@1', children: [] }] },
    ],
  });
  expect(new Set(spans.map((span) => span.spanContext().traceId)).size).toBe(1);
  expect(
    spans.find((span) => span.name.startsWith('invoke_agent'))?.parentSpanContext,
  ).toBeUndefined();
  for (const span of spans) expect(span.status.code).toBe(SpanStatusCode.UNSET);
  expect(serializeSpans(spans)).not.toMatch(
    /at36-(credential|error-message)-canary|at36 model|at36 capability/,
  );
});

test.each([false, true])(
  'AT-36 failed model and capability spans omit errors and credentials with text opt-in %s',
  async (text) => {
    const { spans, snapshot, events } = await completeSpanTree(true, text);
    expect(assertSpanTree(spans, text ? { text: 'allowed' } : undefined)).toEqual({
      name: 'invoke_agent conformance/complete-tree',
      children: [
        { name: 'galaxie.node a', children: [{ name: 'chat mock-1', children: [] }] },
        { name: 'galaxie.node b', children: [{ name: 'execute_tool lookup@1', children: [] }] },
      ],
    });
    const model = spans.find((span) => span.name === 'chat mock-1');
    const capability = spans.find((span) => span.name === 'execute_tool lookup@1');
    const root = spans.find((span) => span.name.startsWith('invoke_agent'));
    for (const span of [model, capability, root]) {
      expect(span?.status.code).toBe(SpanStatusCode.ERROR);
      expect(span?.attributes['error.type']).toBeDefined();
      expect(span?.status.message).toBeUndefined();
      expect(span?.events).toEqual([]);
    }
    expect(model?.attributes['galaxie.error.code']).toBeUndefined();
    expect(capability?.attributes['galaxie.error.code']).toBe('unavailable');
    expect(root?.attributes['galaxie.error.code']).toBe('unavailable');
    expect(root?.attributes['galaxie.run.status']).toBe('failed');
    expect(model?.attributes['gen_ai.input.messages'] !== undefined).toBe(text);
    expect(model?.attributes['gen_ai.output.messages']).toBeUndefined();
    expect(capability?.attributes['gen_ai.tool.call.arguments'] !== undefined).toBe(text);
    if (!text) expectNoText(spans);
    expect(serializeSpans(spans) + JSON.stringify({ snapshot, events })).not.toMatch(
      /at36-(credential|error-message)-canary/,
    );
  },
);
