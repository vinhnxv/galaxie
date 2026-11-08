// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  createLangGraphAdapter,
  type LangGraphAgent,
  type LangGraphHost,
  type LangGraphServices,
} from '@galaxie-ai/adapter-langgraph';
import {
  type AgentSnapshot,
  type BudgetLimits,
  createRuntime,
  type DiagnosticEvent,
  defineAgentDefinition,
  galaxieField,
  type ModelDescriptor,
  type ModelFeature,
  type ModelRoute,
  type ModelRouting,
} from '@galaxie-ai/core';
import { MockChatModel } from '@galaxie-ai/models/mock';
import { HumanMessage } from '@langchain/core/messages';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph/web';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { binding, collect } from '../../packages/core/test/fake-executor.js';
import {
  assertSpanTree,
  createSpanRecorder,
  serializeSpans,
} from '../../packages/core/test/span-tree.js';

const ROLE = 'tutor.feedback';
const PROMPT = 'router conformance request';
const state = Annotation.Root({ text: Annotation<string>, answer: Annotation<string> });
const local: ModelDescriptor = {
  destination: 'in-browser',
  modality: 'text',
  features: ['streaming', 'cancellation'],
  pricing: { inputPerToken: 0, outputPerToken: 0 },
};
const remote: ModelDescriptor = { ...local, destination: 'third-party' };
const localRoute: ModelRoute = { providers: ['local'], allow: ['in-browser'], maxTokens: 1000 };

function mock(text = 'scripted response'): MockChatModel {
  return new MockChatModel({ [PROMPT]: { id: 'mock-reply', text } });
}

function routing(
  providers: ModelRouting['providers'],
  route: ModelRoute,
  callbacks: Pick<ModelRouting, 'consent' | 'getCredential'> = {},
): ModelRouting {
  return { providers, roles: { [ROLE]: route }, ...callbacks };
}

function singleCall(host: LangGraphHost): ReturnType<LangGraphAgent> {
  const model = host.langchain.chatModel(ROLE);
  return new StateGraph(state)
    .addNode('respond', async ({ text }, config) => ({
      answer: (await model.invoke([new HumanMessage(text)], config)).content,
    }))
    .addEdge(START, 'respond')
    .addEdge('respond', END)
    .compile();
}

async function run(options: {
  readonly models: ModelRouting;
  readonly chatModels: LangGraphServices['chatModels'];
  readonly agent?: LangGraphAgent;
  readonly privateInput?: boolean;
  readonly requires?: readonly ModelFeature[];
  readonly budgets?: Partial<BudgetLimits>;
}) {
  const { exporter, provider } = createSpanRecorder();
  const diagnostics: DiagnosticEvent[] = [];
  const snapshots: AgentSnapshot<unknown>[] = [];
  const runtime = createRuntime({
    appId: 'routing-conformance',
    executors: [createLangGraphAdapter()],
    tracerProvider: provider,
    diagnostics: (event) => diagnostics.push(event),
    ...(options.budgets === undefined ? {} : { budgets: options.budgets }),
  });
  const definition = defineAgentDefinition({
    id: 'conformance/models',
    version: '1.0.0',
    executor: 'langgraph-js',
    input: z.object({
      text: z
        .string()
        .meta(galaxieField({ label: options.privateInput ? 'private-user' : 'public' })),
    }),
    models: {
      [ROLE]: {
        modality: 'text',
        ...(options.requires === undefined ? {} : { requires: options.requires }),
      },
    },
    capabilities: {
      optional: {
        'private.read@1': {
          input: z.null(),
          output: z.object({ sentence: z.string().meta(galaxieField({ label: 'private-user' })) }),
          kind: 'read',
        },
      },
    },
  });
  try {
    const instance = await runtime.create(definition, {
      principalScope: 'routing-test-user',
      agent: options.agent ?? singleCall,
      models: options.models,
      services: { chatModels: options.chatModels },
      bindings: {
        'private.read@1': {
          ...binding(),
          invoke: async () => ({ sentence: 'private learner sentence' }),
        },
      },
    });
    snapshots.push(instance.getSnapshot());
    instance.subscribe(() => snapshots.push(instance.getSnapshot()));
    await instance.prepare();
    const { runId } = await instance.start({ text: PROMPT });
    const events = await collect(instance.events(runId));
    await runtime.dispose();
    await provider.forceFlush();
    return {
      events,
      snapshots,
      snapshot: instance.getSnapshot(),
      spans: exporter.getFinishedSpans(),
      diagnostics,
    };
  } finally {
    await runtime.dispose();
    await provider.shutdown();
  }
}

test.each([undefined, 16, 128])(
  'a route reservation of 64 limits invoke and stream with caller limit %s',
  async (maxTokens) => {
    const provider = mock();
    const result = await run({
      models: routing({ local }, { ...localRoute, maxTokens: 64 }),
      chatModels: { local: provider },
      budgets: { tokens: 128 },
      agent: (host) => {
        const model = host.langchain.chatModel(ROLE);
        return new StateGraph(state)
          .addNode('respond', async ({ text }, config) => {
            const options = { ...config, ...(maxTokens === undefined ? {} : { maxTokens }) };
            const reply = await model.invoke(text, options);
            let streamed = '';
            for await (const chunk of await model.stream(text, options)) streamed += chunk.text;
            expect(streamed).toBe(reply.text);
            return { answer: streamed };
          })
          .addEdge(START, 'respond')
          .addEdge('respond', END)
          .compile();
      },
    });
    const expected = maxTokens === 16 ? 16 : 64;
    expect(provider.maxTokens).toEqual([expected, expected]);
    expect(result.snapshot.run).toMatchObject({ status: 'succeeded' });
  },
);

test('AE1 and AE2 consent selects the first remote provider, then a capability label narrows the route to local', async () => {
  const remoteModel = mock('remote response');
  const localModel = mock('local response');
  const consents: unknown[] = [];
  const result = await run({
    models: routing(
      { remote, local },
      { providers: ['remote', 'local'], allow: ['third-party', 'in-browser'], maxTokens: 1000 },
      {
        consent: (request) => {
          consents.push({
            role: request.role,
            destination: request.destination,
            providers: request.providers,
            previous: request.previous,
          });
          return true;
        },
      },
    ),
    chatModels: { remote: remoteModel, local: localModel },
    agent: (host) => {
      const model = host.langchain.chatModel(ROLE);
      return new StateGraph(state)
        .addNode('respond', async ({ text }, config) => {
          const first = await model.invoke([new HumanMessage(text)], config);
          await host.capabilities.call('private.read@1', null, config);
          const second = await model.invoke([new HumanMessage(text)], config);
          return { answer: `${String(first.content)} then ${String(second.content)}` };
        })
        .addEdge(START, 'respond')
        .addEdge('respond', END)
        .compile();
    },
  });
  expect(result.events.at(-1)).toMatchObject({
    type: 'output',
    output: { answer: 'remote response then local response' },
  });
  expect(remoteModel.calls).toBe(1);
  expect(localModel.calls).toBe(1);
  expect(consents).toEqual([
    { role: ROLE, destination: 'third-party', providers: ['remote'], previous: undefined },
  ]);
  const routes = [
    ...new Set(
      result.snapshots
        .map((snapshot) => JSON.stringify(snapshot.routes?.[ROLE]))
        .filter((value) => value !== undefined),
    ),
  ].map((value) => JSON.parse(value));
  expect(routes).toEqual([
    { providerId: 'remote', destination: 'third-party' },
    { providerId: 'local', destination: 'in-browser', changedFrom: 'third-party' },
  ]);
  expect(result.snapshot.run?.labels).toEqual(['private-user', 'public']);
  expect(result.snapshot.routes?.[ROLE]).toEqual({
    providerId: 'local',
    destination: 'in-browser',
    changedFrom: 'third-party',
  });
  assertSpanTree(result.spans);
});

test.each([true, false])(
  'AE3 private input denies the remote provider with forwarded config: %s',
  async (forwardConfig) => {
    const model = mock();
    const result = await run({
      privateInput: true,
      models: routing(
        { remote },
        { providers: ['remote'], allow: ['third-party'], maxTokens: 1000 },
        { consent: () => true },
      ),
      chatModels: { remote: model },
      agent: (host) =>
        new StateGraph(state)
          .addNode('respond', async ({ text }, config) => ({
            answer: (
              await host.langchain
                .chatModel(ROLE)
                .invoke([new HumanMessage(text)], forwardConfig ? config : undefined)
            ).content,
          }))
          .addEdge(START, 'respond')
          .addEdge('respond', END)
          .compile(),
    });
    expect(result.events.at(-1)).toMatchObject({ type: 'error', error: { code: 'denied' } });
    expect(model.calls).toBe(0);
    expect(result.snapshot.routes).toBeUndefined();
    expect(result.spans.some((span) => span.name.startsWith('chat'))).toBe(false);
  },
);

test('AE3 a remote route without consent is denied and a missing required feature is unavailable', async () => {
  const remoteModel = mock();
  const denied = await run({
    models: routing({ remote }, { providers: ['remote'], allow: ['third-party'], maxTokens: 1000 }),
    chatModels: { remote: remoteModel },
  });
  expect(denied.events.at(-1)).toMatchObject({ type: 'error', error: { code: 'denied' } });
  expect(remoteModel.calls).toBe(0);
  const localModel = mock();
  const unavailable = await run({
    models: routing({ local }, localRoute),
    chatModels: { local: localModel },
    requires: ['structured-output'],
  });
  expect(unavailable.events.at(-1)).toMatchObject({
    type: 'error',
    error: { code: 'unavailable' },
  });
  expect(localModel.calls).toBe(0);
});

test('AE3 refused remote consent falls through to the next listed local provider', async () => {
  const remoteModel = mock();
  const localModel = mock();
  const result = await run({
    models: routing(
      { remote, local },
      { providers: ['remote', 'local'], allow: ['third-party', 'in-browser'], maxTokens: 1000 },
      { consent: () => false },
    ),
    chatModels: { remote: remoteModel, local: localModel },
  });
  expect(result.events.at(-1)?.type).toBe('output');
  expect(remoteModel.calls).toBe(0);
  expect(localModel.calls).toBe(1);
  expect(result.snapshot.routes?.[ROLE]).toEqual({
    providerId: 'local',
    destination: 'in-browser',
  });
});

test.each(['tokens', 'cost'] as const)(
  'AE4 %s reservations fail before the second mock call and record the budget on the root span',
  async (budget) => {
    const model = mock();
    const descriptor = budget === 'cost' ? { ...local, pricing: 'unknown' as const } : local;
    const route = budget === 'cost' ? { ...localRoute, maxCost: 5 } : localRoute;
    const result = await run({
      models: routing({ local: descriptor }, route),
      chatModels: { local: model },
      budgets: budget === 'tokens' ? { tokens: 1500 } : { cost: 7 },
      agent: (host) => {
        const model = host.langchain.chatModel(ROLE);
        return new StateGraph(state)
          .addNode('respond', async ({ text }, config) => {
            await model.invoke([new HumanMessage(text)], config);
            return { answer: (await model.invoke([new HumanMessage(text)], config)).content };
          })
          .addEdge(START, 'respond')
          .addEdge('respond', END)
          .compile();
      },
    });
    expect(model.calls).toBe(1);
    expect(result.events.at(-1)).toMatchObject({
      type: 'error',
      error: { code: 'budget_exceeded' },
    });
    expect(result.snapshot.run).toMatchObject({
      status: 'failed',
      error: { code: 'budget_exceeded' },
    });
    expect(
      result.spans.find((span) => span.name.startsWith('invoke_agent'))?.attributes,
    ).toMatchObject({ 'galaxie.budget.name': budget, 'galaxie.error.code': 'budget_exceeded' });
    assertSpanTree(result.spans);
  },
);

test('AE4 actual usage over the reservation retains R14 route attributes when budget failure closes the chat span', async () => {
  const model = new MockChatModel({
    [PROMPT]: {
      id: 'overage',
      text: 'overage response',
      usage: { input_tokens: 8, output_tokens: 8, total_tokens: 16 },
    },
  });
  const result = await run({
    models: routing({ local }, { ...localRoute, maxTokens: 5 }),
    chatModels: { local: model },
    budgets: { tokens: 10 },
  });
  expect(model.calls).toBe(1);
  expect(result.events.at(-1)).toMatchObject({ type: 'error', error: { code: 'budget_exceeded' } });
  expect(result.spans.find((span) => span.name === 'chat mock-1')?.attributes).toMatchObject({
    'galaxie.destination.class': 'in-browser',
    'galaxie.model.provider': 'local',
  });
  expect(
    result.spans.find((span) => span.name.startsWith('invoke_agent'))?.attributes[
      'galaxie.budget.name'
    ],
  ).toBe('tokens');
  assertSpanTree(result.spans);
});

test.each(['success', 'credential-error', 'provider-error'] as const)(
  'AE5 %s keeps the credential out of spans, events, snapshots and ErrorInfo',
  async (outcome) => {
    const canary = 'canary-credential-5e1d';
    const credentials: string[] = [];
    const providerModel =
      outcome === 'provider-error'
        ? new MockChatModel({ [PROMPT]: { error: new Error(canary) } })
        : mock();
    const result = await run({
      models: routing(
        { credentialed: { ...local, destination: 'host-server', credential: true } },
        { providers: ['credentialed'], allow: ['host-server'], maxTokens: 1000 },
        {
          consent: () => true,
          getCredential: async () => {
            if (outcome === 'credential-error') throw new Error(canary);
            return canary;
          },
        },
      ),
      chatModels: {
        credentialed: ({ credential }) => {
          credentials.push(credential);
          return providerModel;
        },
      },
    });
    expect(credentials).toEqual(outcome === 'credential-error' ? [] : [canary]);
    expect(providerModel.calls).toBe(outcome === 'credential-error' ? 0 : 1);
    expect(result.events.at(-1)).toMatchObject(
      outcome === 'success'
        ? { type: 'output' }
        : {
            type: 'error',
            error: { code: outcome === 'credential-error' ? 'unavailable' : 'executor_error' },
          },
    );
    expect(
      serializeSpans(result.spans) +
        JSON.stringify({
          events: result.events,
          snapshots: result.snapshots,
          snapshot: result.snapshot,
        }),
    ).not.toContain(canary);
    if (outcome === 'credential-error') {
      const diagnostic = result.diagnostics.find((event) => event.kind === 'model_failed');
      expect(diagnostic).toBeDefined();
      expect(diagnostic).not.toHaveProperty('error');
      expect(JSON.stringify(diagnostic)).not.toContain(canary);
      expect(result.snapshot.routes).toBeUndefined();
    } else {
      expect(result.spans.find((span) => span.name === 'chat mock-1')?.attributes).toMatchObject({
        'galaxie.destination.class': 'host-server',
        'galaxie.model.provider': 'credentialed',
      });
    }
    assertSpanTree(result.spans);
  },
);

test('R3 stream inside a graph node is routed and yields each scripted word', async () => {
  const model = mock();
  const words: unknown[] = [];
  const result = await run({
    models: routing({ local }, localRoute),
    chatModels: { local: model },
    agent: (host) =>
      new StateGraph(state)
        .addNode('respond', async ({ text }, config) => {
          for await (const chunk of await host.langchain
            .chatModel(ROLE)
            .stream([new HumanMessage(text)], config))
            words.push(chunk.content);
          return { answer: words.join('') };
        })
        .addEdge(START, 'respond')
        .addEdge('respond', END)
        .compile(),
  });
  expect(result.events.at(-1)).toMatchObject({
    type: 'output',
    output: { answer: 'scripted response' },
  });
  expect(words).toEqual(['scripted ', 'response']);
  expect(model.calls).toBe(1);
  expect(result.snapshot.routes?.[ROLE]).toEqual({
    providerId: 'local',
    destination: 'in-browser',
  });
});

test.each(['batch', 'streamEvents'] as const)(
  'R3 %s inside a graph node is routed on Node and Chromium',
  async (entryPoint) => {
    const model = mock();
    const streamedEvents: unknown[] = [];
    const result = await run({
      models: routing({ local }, localRoute),
      chatModels: { local: model },
      agent: (host) =>
        new StateGraph(state)
          .addNode('respond', async ({ text }, config) => {
            const routed = host.langchain.chatModel(ROLE);
            if (entryPoint === 'batch')
              await routed.batch([[new HumanMessage(text)], [new HumanMessage(text)]], config);
            else
              streamedEvents.push(
                ...(await collect(routed.streamEvents([new HumanMessage(text)]))),
              );
            return { answer: 'done' };
          })
          .addEdge(START, 'respond')
          .addEdge('respond', END)
          .compile(),
    });
    expect(result.events.at(-1)?.type).toBe('output');
    expect(model.calls).toBe(entryPoint === 'batch' ? 2 : 1);
    if (entryPoint === 'streamEvents') expect(streamedEvents.length).toBeGreaterThan(0);
    expect(result.snapshot.routes?.[ROLE]).toEqual({
      providerId: 'local',
      destination: 'in-browser',
    });
  },
);

test.each(['provider', 'factory', 'metadata'] as const)(
  'AE5 %s credential failure preserves graph error identity and omits raw diagnostic messages and causes',
  async (origin) => {
    const canary = 'canary-credential-diagnostic';
    const raw = new Error(canary);
    let caught: unknown;
    const result = await run({
      models: routing(
        { credentialed: { ...local, destination: 'host-server', credential: true } },
        { providers: ['credentialed'], allow: ['host-server'], maxTokens: 1000 },
        { consent: () => true, getCredential: () => canary },
      ),
      chatModels: {
        credentialed: () => {
          if (origin === 'factory') throw raw;
          const model =
            origin === 'provider' ? new MockChatModel({ [PROMPT]: { error: raw } }) : mock();
          if (origin === 'metadata')
            model.getLsParams = () => {
              throw raw;
            };
          return model;
        },
      },
      agent: (host) =>
        new StateGraph(state)
          .addNode('respond', async ({ text }, config) => {
            try {
              await host.langchain.chatModel(ROLE).invoke([new HumanMessage(text)], config);
            } catch (error) {
              caught = error;
              throw error;
            }
            return {};
          })
          .addEdge(START, 'respond')
          .addEdge('respond', END)
          .compile(),
    });
    expect(caught).toBe(raw);
    expect(result.events.at(-1)?.type).toBe('error');
    const diagnostics = result.diagnostics
      .flatMap(({ error }) => [
        String(error),
        typeof error === 'object' && error !== null && 'cause' in error ? String(error.cause) : '',
      ])
      .join('\n');
    expect(diagnostics).not.toContain(canary);
    expect(result.diagnostics.find((event) => event.kind === 'run_failed')?.error).not.toBe(raw);
  },
);

test('an unrelated failure retains its raw diagnostic identity after a credentialed model call', async () => {
  const raw = new Error('unrelated node failure');
  const result = await run({
    models: routing(
      { credentialed: { ...local, destination: 'host-server', credential: true } },
      { providers: ['credentialed'], allow: ['host-server'], maxTokens: 1000 },
      { consent: () => true, getCredential: () => 'canary-credential-unrelated' },
    ),
    chatModels: { credentialed: () => mock() },
    agent: (host) =>
      new StateGraph(state)
        .addNode('respond', async ({ text }, config) => {
          await host.langchain.chatModel(ROLE).invoke([new HumanMessage(text)], config);
          throw raw;
        })
        .addEdge(START, 'respond')
        .addEdge('respond', END)
        .compile(),
  });
  expect(result.diagnostics.find((event) => event.kind === 'run_failed')?.error).toBe(raw);
});
