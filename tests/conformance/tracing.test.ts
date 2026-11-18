// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createLangGraphAdapter, requestInteraction } from '@galaxie-ai/adapter-langgraph';
import {
  createRuntime,
  type DataLabel,
  type DataPolicy,
  type DestinationClass,
  type DiagnosticEvent,
  defineAgentDefinition,
  type ExecutorEvent,
  galaxieField,
  httpCapability,
  type InteractionId,
  type Schema,
  type ViewRevision,
} from '@galaxie-ai/core';
import { MockChatModel } from '@galaxie-ai/models/mock';
import type { BaseChatModel, LangSmithParams } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import * as web from '@langchain/langgraph/web';
import { SpanStatusCode } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import {
  binding,
  collect,
  FakeExecutor,
  definition as fakeDefinition,
  stream,
} from '../../packages/core/test/fake-executor.js';
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

async function completeSpanTree(failed: boolean, text: boolean, dataPolicy?: DataPolicy) {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  const credentials: string[] = [];
  const getCredential = (): string => treeCredential;
  const runtime = createRuntime({
    appId: 'complete-span-tree',
    executors: [createLangGraphAdapter()],
    tracerProvider: provider,
    ...(text ? { developmentTraceText: { destination: 'third-party' as const } } : {}),
    ...(dataPolicy === undefined ? {} : { dataPolicy }),
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

test('duplicate browser-only destinations still exclude trace text', async () => {
  const { spans } = await textScenario({
    label: 'app',
    destination: 'in-browser',
    policy: { app: { allow: ['in-browser', 'in-browser'] } },
  });
  expectNoText(spans);
});

test('deep accepted JSON submission stays within budget and suppresses resumed trace text', async () => {
  let payload: unknown = 'private submission text';
  for (let depth = 0; depth < 4000; depth++) payload = { nested: payload };
  const interaction = {
    interactionId: 'deep-submit' as InteractionId,
    surfaceId: 'main',
    viewRevision: 'r1' as ViewRevision,
    component: 'tests.Question/v1' as const,
    props: {},
  };
  const executor = new FakeExecutor([
    [{ type: 'interaction', interaction }],
    async function* (request) {
      request.trace
        .start({
          kind: 'model',
          input: [{ role: 'user', parts: [{ type: 'text', content: 'resumed prompt' }] }],
        })
        .end({
          status: 'ok',
          output: [{ role: 'assistant', parts: [{ type: 'text', content: 'resumed answer' }] }],
        });
      yield { type: 'output', output: null };
    },
  ]);
  Object.assign(executor.features, { resume: true });
  executor.agent.pending = async () => interaction;
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  const runtime = createRuntime({
    appId: 'deep-submission',
    executors: [executor],
    tracerProvider: provider,
    developmentTraceText: { destination: 'third-party' },
  });
  const instance = await runtime.create(
    { ...fakeDefinition, input: z.string().meta(galaxieField({ label: 'public' })) },
    { principalScope: 'fixture', agent: {} },
  );
  try {
    await instance.prepare();
    const { runId } = await instance.start('public input');
    for await (const event of instance.events(runId)) if (event.type === 'interaction') break;
    expect(
      await instance.dispatch({
        ...interaction,
        instanceId: instance.instanceId,
        runId,
        action: 'submit',
        payload,
      }),
    ).toMatchObject({ status: 'accepted' });
    await collect(instance.events(runId));
    expect(instance.getSnapshot().run?.status).toBe('succeeded');
    await runtime.dispose();
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    expect(
      spans.filter((span) => span.attributes['gen_ai.operation.name'] === 'chat'),
    ).toHaveLength(1);
    expectNoText(spans.filter((span) => !isRoot(span)));
    expectRootText(spans, ['waiting_input', 'public input'], ['succeeded']);
  } finally {
    await runtime.dispose();
    await provider.shutdown();
  }
});

const rootInput = 'at36-user-typed-canary';
const rootOutput = 'at36 agent reply';
const streamCanary = 'at36-raw-stream-canary';
const leaseCanary = 'at36-lease-credential-canary';
const bearerCanary = 'at36-http-bearer-canary';
const pendingCanary = 'at36-pending-interaction-canary';
const inboxCanary = 'at36-inbox-submission-canary';
const restoredCanary = 'at36-restored-checkpoint-canary';
const inputKey = 'gen_ai.input.messages';
const outputKey = 'gen_ai.output.messages';
const traceDestinations = [
  'in-browser',
  'user-device',
  'user-endpoint',
  'host-server',
  'third-party',
] as const;
const allowPrivate: DataPolicy = { 'private-user': { allow: traceDestinations } };

function rootMessage(role: 'user' | 'assistant', content: string) {
  return JSON.stringify([{ role, parts: [{ type: 'text', content }] }]);
}

async function rootTextScenario({
  input = ` ${rootInput} `,
  inputSchema = z
    .string()
    .trim()
    .meta(galaxieField({ label: 'public' })),
  output = rootOutput,
  destination,
  policy,
  lateLabel,
  restored = false,
  restoreDuringDispatch = false,
  outcome = 'success',
  children = false,
  payloadBytes,
}: {
  input?: string;
  inputSchema?: Schema;
  output?: unknown;
  destination?: DestinationClass;
  policy?: DataPolicy;
  lateLabel?: DataLabel;
  restored?: boolean;
  restoreDuringDispatch?: boolean;
  outcome?: 'success' | 'fail' | 'cancel' | 'pause';
  children?: boolean;
  payloadBytes?: number;
} = {}) {
  const interaction = {
    interactionId: 'at36-root-text' as InteractionId,
    surfaceId: 'main',
    viewRevision: 'r1' as ViewRevision,
    component: 'tests.Question/v1' as const,
    props: { question: pendingCanary },
  };
  const pauseDrain = Promise.withResolvers<void>();
  const credentials: unknown[] = [];
  const executor = new FakeExecutor([
    async function* (request): AsyncGenerator<ExecutorEvent> {
      if (payloadBytes !== undefined) request.payload?.('x'.repeat(payloadBytes - 2));
      if (children) {
        const node = request.trace.start({ kind: 'node', name: 'root-text-fixture' });
        const lease = await request.models.begin('assistant');
        credentials.push(lease.credential);
        const model = request.trace.start(
          {
            kind: 'model',
            model: 'root-text-model',
            input: [{ role: 'user', parts: [{ type: 'text', content: 'child prompt' }] }],
          },
          node,
        );
        lease.end({ inputTokens: 2, outputTokens: 3 });
        model.end({
          status: 'ok',
          usage: { inputTokens: 2, outputTokens: 3 },
          output: [{ role: 'assistant', parts: [{ type: 'text', content: 'child reply' }] }],
        });
        await request.capabilities.call('lookup@1', { id: 'entry' }, { parent: node });
        node.end({ status: 'ok' });
      } else if (lateLabel !== undefined) {
        await request.capabilities.call('lookup@1', { id: 'entry' });
      }
      if (restored) request.registerRestoredData?.({ value: restoredCanary });
      yield stream(streamCanary);
      if (outcome === 'pause') {
        yield { type: 'interaction', interaction };
        if (restoreDuringDispatch) await pauseDrain.promise;
      } else if (outcome === 'fail') throw new Error('at36-root-error-canary');
      else if (outcome === 'cancel' && !request.signal.aborted)
        await new Promise<void>((resolve) =>
          request.signal.addEventListener('abort', () => resolve(), { once: true }),
        );
      let outputRead = false;
      yield {
        type: 'output',
        get output() {
          if (outputRead) return 'at36-reread-output-canary';
          outputRead = true;
          return output;
        },
      };
      yield { type: 'output', output: 'at36-late-output-canary' };
    },
    [{ type: 'output', output }],
  ]);
  Object.assign(executor.features, { resume: true });
  executor.agent.pending = async (_sessionId, options) => {
    if (restoreDuringDispatch) options?.registerRestoredData?.({ value: restoredCanary });
    return interaction;
  };
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  const runtime = createRuntime({
    appId: 'at36-root-text',
    executors: [executor],
    tracerProvider: provider,
    ...(destination === undefined ? {} : { developmentTraceText: { destination } }),
    ...(policy === undefined ? {} : { dataPolicy: policy }),
    budgets: { toolCalls: 1, tokens: 5, ...(payloadBytes === undefined ? {} : { payloadBytes }) },
  });
  const instance = await runtime.create(
    {
      ...fakeDefinition,
      input: inputSchema,
      models: assistantRoles,
      capabilities: {
        optional: {
          'lookup@1': {
            kind: 'read',
            input: z.object({ id: z.enum(['entry']) }),
            output: z.string().meta(galaxieField({ label: lateLabel ?? 'public' })),
          },
        },
      },
    },
    {
      agent: {},
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
        roles: { assistant: { providers: ['assistant'], allow: ['host-server'], maxTokens: 5 } },
        consent: () => true,
        getCredential: () => leaseCanary,
      },
      bindings: {
        'lookup@1': children
          ? httpCapability<{ id: 'entry' }, string>({
              ...binding(),
              destination: 'host-server',
              url: 'https://example.test/lookup/{id}',
              method: 'GET',
              headers: () => ({ authorization: `Bearer ${bearerCanary}` }),
              fetch: async (_input, init) => {
                credentials.push(new Headers(init?.headers).get('authorization'));
                return Response.json('at36-capability-result-canary');
              },
            })
          : { ...binding(), invoke: async () => 'at36-capability-result-canary' },
      },
    },
  );
  try {
    await instance.prepare();
    const { runId } = await instance.start(input);
    if (outcome === 'pause') {
      for await (const event of instance.events(runId)) if (event.type === 'interaction') break;
      if (!restoreDuringDispatch)
        await vi.waitFor(() => expect(exporter.getFinishedSpans().some(isRoot)).toBe(true));
      expect(
        await instance.dispatch({
          ...interaction,
          instanceId: instance.instanceId,
          runId,
          action: 'submit',
          payload: restoreDuringDispatch ? false : inboxCanary,
        }),
      ).toMatchObject({ status: 'accepted' });
      pauseDrain.resolve();
    }
    if (outcome === 'cancel') {
      for await (const event of instance.events(runId)) if (event.type === 'stream') break;
      await instance.cancel(runId);
    }
    const events = (await collect(instance.events(runId))).map(
      ({ eventId: _eventId, runId: _runId, ...event }) => event,
    );
    const status = instance.getSnapshot().run?.status;
    await runtime.dispose();
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    return { spans, status, events, credentials };
  } finally {
    pauseDrain.resolve();
    await runtime.dispose();
    await provider.shutdown();
  }
}

function isRoot(span: ReturnType<InMemorySpanExporter['getFinishedSpans']>[number]) {
  return span.attributes['gen_ai.operation.name'] === 'invoke_agent';
}

function expectRootText(
  spans: ReturnType<InMemorySpanExporter['getFinishedSpans']>,
  ...expected: ReadonlyArray<readonly [status: string, input?: string | undefined, output?: string]>
) {
  const roots = spans.filter(isRoot);
  expect(roots).toHaveLength(expected.length);
  expect(new Set(roots.map((root) => root.spanContext().traceId)).size).toBe(roots.length);
  for (const [segment, [status, input, output]] of expected.entries()) {
    const root = roots.find((span) => span.attributes['galaxie.run.segment'] === segment);
    if (root === undefined) throw new Error(`Missing root span for segment ${segment}.`);
    expect(root.parentSpanContext).toBeUndefined();
    assertSpanTree(
      spans.filter((span) => span.spanContext().traceId === root.spanContext().traceId),
      { text: 'allowed' },
    );
    expect(root.attributes['galaxie.run.status']).toBe(status);
    expect(root.attributes[inputKey]).toBe(
      input === undefined ? undefined : rootMessage('user', input),
    );
    expect(root.attributes[outputKey]).toBe(
      output === undefined ? undefined : rootMessage('assistant', output),
    );
    expect(root.attributes['gen_ai.tool.call.arguments']).toBeUndefined();
  }
}

test('AT-36 root text is opt-in and records only normalized input and the accepted output', async () => {
  const absent = await rootTextScenario({ children: true, payloadBytes: 128 });
  const allowed = await rootTextScenario({
    children: true,
    payloadBytes: 128,
    destination: 'third-party',
    policy: allowPrivate,
  });
  expectRootText(absent.spans, ['succeeded']);
  expectNoText(absent.spans);
  expectRootText(allowed.spans, ['succeeded', rootInput, rootOutput]);
  expect(withoutText(allowed.spans)).toEqual(withoutText(absent.spans));
  expect(
    allowed.spans.find((span) => span.name === 'chat root-text-model')?.attributes,
  ).toMatchObject({
    [inputKey]: rootMessage('user', 'child prompt'),
    [outputKey]: rootMessage('assistant', 'child reply'),
    'gen_ai.usage.input_tokens': 2,
    'gen_ai.usage.output_tokens': 3,
  });
  expect(
    allowed.spans.find((span) => span.name === 'execute_tool lookup@1')?.attributes,
  ).toMatchObject({ 'gen_ai.tool.call.arguments': '{"id":"entry"}' });
  expect(allowed.events).toEqual(absent.events);
  expect(allowed.events.at(-1)).toMatchObject({ type: 'output', output: rootOutput });
  for (const result of [absent, allowed]) {
    expect(result.status).toBe('succeeded');
    expect(result.credentials).toEqual([leaseCanary, `Bearer ${bearerCanary}`]);
    const serialized = serializeSpans(result.spans);
    for (const canary of [
      leaseCanary,
      bearerCanary,
      streamCanary,
      'at36-late-output-canary',
      'at36-reread-output-canary',
      'at36-capability-result-canary',
    ])
      expect(serialized).not.toContain(canary);
  }
  expect(serializeSpans(absent.spans)).not.toContain(rootInput);
  expect(serializeSpans(allowed.spans)).toContain(rootInput);
});

test.each(traceDestinations)(
  'AT-36 root text applies final destination policy for %s',
  async (destination) => {
    const otherDestinations = traceDestinations.filter((value) => value !== destination);
    const allowed = await rootTextScenario({
      destination,
      policy: { 'private-user': { allow: [destination, ...otherDestinations.slice(0, 1)] } },
    });
    expectRootText(allowed.spans, ['succeeded', rootInput, rootOutput]);
    const denied = await rootTextScenario({
      destination,
      policy: { 'private-user': { allow: otherDestinations } },
    });
    expectRootText(denied.spans, ['succeeded', rootInput]);
    const defaults = await rootTextScenario({ destination });
    expectRootText(defaults.spans, ['succeeded', rootInput]);
  },
);

test.each([
  { destination: 'third-party', policy: allowPrivate },
  { destination: 'in-browser', policy: { ...allowPrivate, app: { allow: ['in-browser'] } } },
] as const)(
  'AT-36 root text omits text with a late capability label for $destination',
  async (options) => {
    const { spans } = await rootTextScenario({ ...options, lateLabel: 'app' });
    expectRootText(spans, ['succeeded']);
    expect(spans.find(isRoot)?.attributes['galaxie.run.labels']).toEqual(['app', 'public']);
    expect(serializeSpans(spans)).not.toContain(rootInput);
  },
);

test('AT-36 root text respects labels added by restored data', async () => {
  const { spans } = await rootTextScenario({ destination: 'third-party', restored: true });
  expectRootText(spans, ['succeeded']);
  expect(spans.find(isRoot)?.attributes['galaxie.run.labels']).toEqual(['private-user', 'public']);
  expect(serializeSpans(spans)).not.toMatch(new RegExp(`${rootInput}|${restoredCanary}`));
});

test('AT-36 root text accounts for checkpoint inspection while a paused segment drains', async () => {
  const options = {
    destination: 'third-party',
    outcome: 'pause',
    restoreDuringDispatch: true,
  } as const;
  const denied = await rootTextScenario(options);
  expectRootText(denied.spans, ['waiting_input'], ['succeeded']);
  expect(denied.spans.filter(isRoot).map((span) => span.attributes['galaxie.run.labels'])).toEqual([
    ['public'],
    ['public'],
  ]);
  const allowed = await rootTextScenario({ ...options, policy: allowPrivate });
  expectRootText(allowed.spans, ['waiting_input', rootInput], ['succeeded', undefined, rootOutput]);
  for (const spans of [allowed.spans, denied.spans])
    expect(serializeSpans(spans)).not.toContain(restoredCanary);
});

test('AT-36 root text treats unlabelled start strings as private without changing run labels', async () => {
  const options = {
    destination: 'host-server',
    inputSchema: z.string(),
    input: rootInput,
  } as const;
  const defaults = await rootTextScenario(options);
  expectRootText(defaults.spans, ['succeeded']);
  expect(defaults.spans.find(isRoot)?.attributes['galaxie.run.labels']).toEqual(['app']);
  expect(serializeSpans(defaults.spans)).not.toContain(rootInput);
  const allowed = await rootTextScenario({ ...options, policy: allowPrivate });
  expectRootText(allowed.spans, ['succeeded', rootInput, rootOutput]);
  const labelled = await rootTextScenario({
    ...options,
    inputSchema: z.union([z.string().meta(galaxieField({ label: 'app' })), z.number()]),
  });
  expectRootText(labelled.spans, ['succeeded', rootInput]);
  const impossibleBranch = await rootTextScenario({
    ...options,
    inputSchema: z.union([z.string().meta(galaxieField({ label: 'app' })), z.never()]),
  });
  expectRootText(impossibleBranch.spans, ['succeeded', rootInput]);
  const mixed = await rootTextScenario({
    ...options,
    inputSchema: z.union([
      z.string(),
      z.object({ value: z.string().meta(galaxieField({ label: 'app' })) }),
    ]),
  });
  expectRootText(mixed.spans, ['succeeded']);
  const ambiguous = await rootTextScenario({
    ...options,
    inputSchema: z.union([z.string().meta(galaxieField({ label: 'app' })), z.string()]),
  });
  expectRootText(ambiguous.spans, ['succeeded']);
  const patterned = await rootTextScenario({
    ...options,
    inputSchema: z.union([
      z.string().startsWith('at36-').meta(galaxieField({ label: 'app' })),
      z.string().startsWith('alternate-'),
    ]),
  });
  expectRootText(patterned.spans, ['succeeded']);
});

test.each(['fail', 'cancel'] as const)(
  'AT-36 root text omits both attributes on %s',
  async (outcome) => {
    const { spans, events } = await rootTextScenario({
      destination: 'third-party',
      policy: allowPrivate,
      outcome,
    });
    expectRootText(spans, [outcome === 'fail' ? 'failed' : 'cancelled']);
    expect(events.at(-1)?.type).toBe(outcome === 'fail' ? 'error' : 'cancelled');
    expect(serializeSpans(spans)).not.toMatch(
      /at36-root-error-canary|at36-late-output-canary|at36-user-typed-canary/,
    );
  },
);

test('AT-36 root text records the initial input on pause and only the final reply on resume', async () => {
  const options = { destination: 'third-party', outcome: 'pause' } as const;
  const allowed = await rootTextScenario({ ...options, policy: allowPrivate });
  expectRootText(allowed.spans, ['waiting_input', rootInput], ['succeeded', undefined, rootOutput]);
  expect(allowed.events.at(-1)).toMatchObject({ type: 'output', output: rootOutput });
  const defaults = await rootTextScenario(options);
  expectRootText(defaults.spans, ['waiting_input', rootInput], ['succeeded']);
  for (const spans of [allowed.spans, defaults.spans])
    expect(serializeSpans(spans)).not.toMatch(new RegExp(`${pendingCanary}|${inboxCanary}`));
});

test('AT-36 root text omits structured invocations and empty strings', async () => {
  const structured = await completeSpanTree(false, true, allowPrivate);
  expect(structured.events.at(-1)).toMatchObject({
    type: 'output',
    output: { value: 'public input' },
  });
  expectRootText(structured.spans, ['succeeded']);
  const empty = await rootTextScenario({
    destination: 'third-party',
    policy: allowPrivate,
    input: ' ',
    output: '',
  });
  expectRootText(empty.spans, ['succeeded']);
});

test.each([
  { payloadBytes: 128, limit: 128 },
  { payloadBytes: 32 * 1024, limit: 16 * 1024 },
])(
  'AT-36 root text bounds each encoded attribute at $limit UTF-8 bytes',
  async ({ payloadBytes, limit }) => {
    const escaped = '😀\n"\\\0\ud800';
    const utf8 = new TextEncoder();
    const atLimit = (role: 'user' | 'assistant'): string =>
      escaped + 'x'.repeat(limit - utf8.encode(rootMessage(role, escaped)).byteLength);
    const input = atLimit('user');
    const output = atLimit('assistant');
    expect(utf8.encode(rootMessage('user', input))).toHaveLength(limit);
    expect(utf8.encode(rootMessage('assistant', output))).toHaveLength(limit);
    const options = { destination: 'third-party', policy: allowPrivate, payloadBytes } as const;
    const exact = await rootTextScenario({ ...options, input, output });
    expectRootText(exact.spans, ['succeeded', input, output]);
    const bigInput = await rootTextScenario({ ...options, input: `${input}x`, output });
    expectRootText(bigInput.spans, ['succeeded', undefined, output]);
    const bigOutput = await rootTextScenario({ ...options, input, output: `${output}x` });
    expectRootText(bigOutput.spans, ['succeeded', input]);
    expect(bigOutput.events.at(-1)).toMatchObject({ type: 'output', output: `${output}x` });
  },
);

test('AT-36 root text bounds candidates before encoding and omits serialization failures', async () => {
  const oversized = 'x'.repeat(129);
  const output = 'at36-serialization-failure';
  const attempted: string[] = [];
  const stringify = JSON.stringify;
  const encoder = vi.spyOn(JSON, 'stringify').mockImplementation((value, ...args) => {
    const content: unknown = Array.isArray(value) ? value[0]?.parts?.[0]?.content : undefined;
    if (content === oversized || content === output) {
      attempted.push(content);
      throw new TypeError('Root text cannot be serialized.');
    }
    return Reflect.apply(stringify, JSON, [value, ...args]);
  });
  const { spans, events } = await rootTextScenario({
    destination: 'third-party',
    policy: allowPrivate,
    input: oversized,
    output,
    payloadBytes: 128,
  }).finally(() => encoder.mockRestore());
  expect(attempted).toEqual([output]);
  expectRootText(spans, ['succeeded']);
  expect(events.at(-1)).toMatchObject({ type: 'output', output });
});
