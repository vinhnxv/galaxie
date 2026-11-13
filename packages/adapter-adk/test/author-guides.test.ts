// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  createRuntime,
  defineAgentDefinition,
  type ExecutorAdapter,
  type ModelRouting,
  type RunEvent,
  type RunId,
  type SessionId,
} from '@galaxie-ai/core';
import {
  BaseLlm,
  type BaseTool,
  BaseToolset,
  FunctionTool,
  InMemoryRunner,
  isFinalResponse,
  LlmAgent,
  type LlmRequest,
  type LlmResponse,
  PlanReActPlanner,
} from '@google/adk';
import { AIMessage } from '@langchain/core/messages';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { type AdkAgent, createAdkAdapter, defineAdkEntry } from '../src/index.js';
import { openAiTools } from '../src/llm.js';
import { inputAgent } from './guide-snippets/input-agent.js';
import { answerCity, questionBinding, questionDefinition } from './guide-snippets/input-host.js';
import { modelAfter } from './guide-snippets/model-after.js';
import { modelBefore } from './guide-snippets/model-before.js';
import { plannerBefore } from './guide-snippets/planner-before.js';
import { toolsetAgent } from './guide-snippets/toolset-flat.js';
import { FakeChatModel, fakeModels, fakeTrace } from './support/fixtures.js';

const runtimes: Array<{ dispose(): Promise<void> }> = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
});
const preparation = { roles: ['answer'], providers: { mock: { credential: false } } };
const routing: ModelRouting = {
  providers: {
    mock: {
      destination: 'in-browser',
      modality: 'text',
      languages: ['en'],
      features: ['tool-calling'],
      pricing: { inputPerToken: 0, outputPerToken: 0 },
    },
  },
  roles: { answer: { providers: ['mock'], allow: ['in-browser'], maxTokens: 100 } },
};
const questionArgs = { message: 'Which city?' };

async function startInput(factory: AdkAgent = inputAgent, toolName = 'ask_city') {
  const calls: unknown[] = [];
  const provider = new FakeChatModel((_, turn) =>
    turn === 0
      ? new AIMessage({
          content: '',
          tool_calls: [{ id: 'city-call', name: toolName, args: questionArgs }],
        })
      : new AIMessage({ content: 'finished' }),
  );
  const runtime = createRuntime({
    appId: 'adk-author-guides',
    executors: [createAdkAdapter() as ExecutorAdapter<unknown, unknown>],
  });
  runtimes.push(runtime);
  const instance = await runtime.create(questionDefinition, {
    principalScope: 'user',
    services: { chatModels: { mock: provider } },
    models: routing,
    agent: factory,
    bindings: {
      'question.ask@1': {
        ...questionBinding,
        async invoke(value, context) {
          calls.push(value);
          return questionBinding.invoke(value, context);
        },
      },
    },
  });
  await instance.prepare();
  const { runId } = await instance.start({ prompt: 'Ask for a city.' });
  const events: RunEvent[] = [];
  for await (const event of instance.events(runId)) {
    events.push(event);
    if (event.type === 'interaction') break;
  }
  return { instance, runId, events, calls, provider };
}

test('the city example pauses and its host answer reaches the model once', async () => {
  const seen = await startInput();
  const pending = seen.events.find((event) => event.type === 'interaction');
  if (pending?.type !== 'interaction') throw new Error('Missing city interaction.');
  expect(pending.interaction).toMatchObject({
    surfaceId: 'main',
    viewRevision: 'r1',
    component: 'app.CityQuestion/v1',
    props: { requests: [{ kind: 'long-running', tool: 'ask_city', args: questionArgs }] },
  });
  expect(seen.calls).toEqual([questionArgs]);
  expect(await answerCity(seen.instance, seen.runId, pending.interaction, 'Hue')).toMatchObject({
    status: 'accepted',
  });
  const events = [];
  for await (const event of seen.instance.events(seen.runId)) events.push(event);
  expect(events.at(-1)).toMatchObject({ type: 'output', output: 'finished' });
  expect(seen.provider.seen).toHaveLength(2);
  expect(
    seen.provider.seen[1]?.messages
      .filter((message) => message.type === 'tool')
      .map((message) => message.content),
  ).toEqual(['{"city":"Hue"}']);
  expect(seen.calls).toEqual([questionArgs]);
});

for (const payload of [{}, { city: 1 }, { city: '' }, { city: 'Hue', extra: true }])
  test(`the city example rejects ${JSON.stringify(payload)} before another model request`, async () => {
    const seen = await startInput();
    const pending = seen.events.find((event) => event.type === 'interaction');
    if (pending?.type !== 'interaction') throw new Error('Missing city interaction.');
    expect(
      await seen.instance.dispatch({
        instanceId: seen.instance.instanceId,
        runId: seen.runId,
        ...pending.interaction,
        action: 'submit',
        payload,
      }),
    ).toMatchObject({ status: 'accepted' });
    const events = [];
    for await (const event of seen.instance.events(seen.runId)) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'invalid' } });
    expect(seen.provider.seen).toHaveLength(1);
    expect(seen.calls).toEqual([questionArgs]);
  });

test('a reserved-name capability runs once then refuses without an interaction', async () => {
  const seen = await startInput(
    (host) =>
      defineAdkEntry({
        agent: new LlmAgent({
          name: 'root',
          model: host.adk.llm('answer'),
          tools: [
            host.adk.capabilityTool('question.ask@1', {
              toolName: 'adk_request_input',
              description: 'Ask which city to use.',
              parameters: z.object({ message: z.string() }),
              longRunning: true,
            }),
          ],
        }),
        interaction: () => {
          throw new Error('No answerable interaction expected.');
        },
      }),
    'adk_request_input',
  );
  expect(seen.events.at(-1)).toMatchObject({ type: 'error', error: { code: 'unsupported' } });
  expect(seen.events.some((event) => event.type === 'interaction')).toBe(false);
  expect(seen.calls).toEqual([questionArgs]);
  expect(seen.provider.seen).toHaveLength(1);
});

test('the native input helper refuses with zero capability invocations', async () => {
  const seen = await startInput(
    (host) =>
      new LlmAgent({
        name: 'root',
        model: host.adk.llm('answer'),
        tools: [host.adk.requestInput()],
      }),
    'adk_request_input',
  );
  expect(seen.events.at(-1)).toMatchObject({ type: 'error', error: { code: 'unsupported' } });
  expect(seen.events.some((event) => event.type === 'interaction')).toBe(false);
  expect(seen.calls).toEqual([]);
});

async function runFactory(factory: AdkAgent, reply = 'done') {
  const provider = new FakeChatModel(() => new AIMessage({ content: reply }));
  const prepared = await createAdkAdapter().prepare(
    factory,
    { chatModels: { mock: provider } },
    { signal: new AbortController().signal, models: preparation },
  );
  const models = fakeModels();
  try {
    const events = [];
    for await (const event of prepared.run({
      runId: 'run' as RunId,
      sessionId: 'session' as SessionId,
      command: { type: 'start', input: { prompt: 'question' } },
      signal: new AbortController().signal,
      trace: fakeTrace().trace,
      models: models.port,
      limits: { steps: 5 },
      capabilities: {
        async call(): Promise<never> {
          throw new Error('No capability expected.');
        },
      },
    }))
      events.push(event);
    expect(provider.seen).toHaveLength(1);
    expect(models.leases.map((lease) => lease.role)).toEqual(['answer']);
    return events.filter((event) => event.type === 'output').map((event) => event.output);
  } finally {
    await prepared.dispose();
  }
}

test('the native string model and planner snippets refuse before model dispatch', async () => {
  for (const factory of [modelBefore, plannerBefore]) {
    const provider = new FakeChatModel(() => new AIMessage({ content: 'unused' }));
    await expect(
      createAdkAdapter().prepare(
        factory,
        { chatModels: { mock: provider } },
        { signal: new AbortController().signal, models: preparation },
      ),
    ).rejects.toMatchObject({ code: 'unsupported' });
    expect(provider.seen).toEqual([]);
  }
});

test('a fresh factory works on sequential and concurrent preparations', async () => {
  expect(await runFactory(modelAfter)).toEqual(['done']);
  expect(await runFactory(modelAfter)).toEqual(['done']);
  expect(await Promise.all([runFactory(modelAfter), runFactory(modelAfter)])).toEqual([
    ['done'],
    ['done'],
  ]);
});

class StaticTools extends BaseToolset {
  readonly tools: BaseTool[];
  constructor(tools: BaseTool[]) {
    super([]);
    this.tools = tools;
  }
  override async getTools(): Promise<BaseTool[]> {
    return [...this.tools];
  }
  override async close(): Promise<void> {}
}

async function nativeRun(agent: LlmAgent) {
  const runner = new InMemoryRunner({ agent, appName: 'author-guides' });
  const session = await runner.sessionService.createSession({
    appName: 'author-guides',
    userId: 'user',
  });
  const final: string[] = [];
  for await (const event of runner.runAsync({
    userId: 'user',
    sessionId: session.id,
    newMessage: { role: 'user', parts: [{ text: 'question' }] },
  }))
    if (isFinalResponse(event))
      final.push(
        (event.content?.parts ?? [])
          .filter((part) => !part.thought)
          .map((part) => part.text ?? '')
          .join(''),
      );
  return final;
}

class Scripted extends BaseLlm {
  readonly schemas: unknown[] = [];
  readonly reply: string;
  readonly tool: boolean;
  turn = 0;
  constructor(reply: string, tool = false) {
    super({ model: 'scripted' });
    this.reply = reply;
    this.tool = tool;
  }
  override async *generateContentAsync(request: LlmRequest): AsyncGenerator<LlmResponse, void> {
    this.schemas.push(openAiTools(request).map((entry) => entry.function));
    yield {
      content: {
        role: 'model',
        parts:
          this.tool && this.turn++ === 0
            ? [{ functionCall: { name: 'double', args: { value: 21 } } }]
            : [{ text: this.reply }],
      },
      turnComplete: true,
    };
  }
  override async connect(): Promise<never> {
    throw new Error('No live connection.');
  }
}

test('the flat capability list matches native toolset declarations and results', async () => {
  const parameters = z.object({ value: z.number() });
  const calls: unknown[] = [];
  const provider = new FakeChatModel((_, turn) =>
    turn === 0
      ? new AIMessage({
          content: '',
          tool_calls: [{ id: 'double-call', name: 'double', args: { value: 21 } }],
        })
      : new AIMessage({ content: 'done' }),
  );
  const definition = defineAgentDefinition({
    id: 'tests/adk-guide-toolset',
    version: '1.0.0',
    executor: 'adk-js',
    input: z.object({ prompt: z.string() }),
    models: { answer: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' } },
    capabilities: {
      required: { 'math.double@1': { kind: 'read', input: parameters, output: parameters } },
    },
  });
  const runtime = createRuntime({
    appId: 'author-guides',
    executors: [createAdkAdapter() as ExecutorAdapter<unknown, unknown>],
  });
  runtimes.push(runtime);
  const instance = await runtime.create(definition, {
    principalScope: 'user',
    models: routing,
    services: { chatModels: { mock: provider } },
    agent: toolsetAgent,
    bindings: {
      'math.double@1': {
        kind: 'read',
        destination: 'in-browser',
        timeoutMs: 1000,
        concurrency: 1,
        grantScope: 'instance',
        approval: 'none',
        retry: 'none',
        async invoke(input: { value: number }) {
          calls.push(input);
          return { value: input.value * 2 };
        },
      },
    },
  });
  await instance.prepare();
  const { runId } = await instance.start({ prompt: 'question' });
  const output = [];
  for await (const event of instance.events(runId))
    if (event.type === 'output') output.push(event.output);
  const nativeCalls: unknown[] = [];
  const native = new Scripted('done', true);
  const nativeOutput = await nativeRun(
    new LlmAgent({
      name: 'root',
      model: native,
      tools: [
        new StaticTools([
          new FunctionTool({
            name: 'double',
            description: 'Double.',
            parameters,
            async execute(input) {
              nativeCalls.push(input);
              return { value: input.value * 2 };
            },
          }),
        ]),
      ],
    }),
  );
  expect(output).toEqual(['done']);
  expect(nativeOutput).toEqual(output);
  expect(calls).toEqual([{ value: 21 }]);
  expect(nativeCalls).toEqual(calls);
  expect(provider.seen.map((call) => call.toolSchemas)).toEqual(native.schemas);
});

test('native PlanReAct retags the final answer while the planner-less script keeps tags', async () => {
  const reply = '/*PLANNING*/think/*FINAL_ANSWER*/done';
  expect(await runFactory(modelAfter, reply)).toEqual([reply]);
  expect(
    await nativeRun(
      new LlmAgent({ name: 'root', model: new Scripted(reply), planner: new PlanReActPlanner() }),
    ),
  ).toEqual(['done']);
});
