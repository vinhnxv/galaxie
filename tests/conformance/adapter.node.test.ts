// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import {
  createLangGraphAdapter,
  type LangGraphAgent,
  type LangGraphServices,
  STREAM_MODES,
} from '@galaxie/adapter-langgraph';
import {
  createRuntime,
  type DiagnosticEvent,
  defineAgentDefinition,
  type ExecutorAdapter,
  type RunRequest,
} from '@galaxie/core';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { HumanMessage } from '@langchain/core/messages';
import {
  Annotation,
  type BaseCheckpointSaver,
  END,
  type LangGraphRunnableConfig,
  MemorySaver,
  NodeInterrupt,
  START,
  StateGraph,
} from '@langchain/langgraph/web';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import adapterMetadata from '../../packages/adapter-langgraph/package.json' with { type: 'json' };
import { collect, deferred, flush } from '../../packages/core/test/fake-executor.js';
import { assertSpanTree, serializeSpans } from '../../packages/core/test/span-tree.js';
import {
  createModelLatch,
  FixtureModelError,
  ScriptedChatModel,
} from './support/scripted-chat-model.js';

const definition = defineAgentDefinition({
  id: 'tests/langgraph',
  version: '1.0.0',
  executor: 'langgraph-js',
  input: z.object({ value: z.number() }),
});

async function ready(
  agent: LangGraphAgent,
  services?: LangGraphServices,
  diagnostics?: (event: DiagnosticEvent) => void,
) {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  const runtime = createRuntime({
    appId: 'tests',
    executors: [createLangGraphAdapter()],
    tracerProvider: provider,
    ...(diagnostics ? { diagnostics } : {}),
  });
  const instance = await runtime.create(definition, {
    principalScope: 'private-principal',
    agent,
    ...(services ? { services } : {}),
  });
  await instance.prepare();
  return { runtime, instance, exporter, provider };
}

test('runs LangGraph and publishes native chunks and the final root state', async () => {
  const state = Annotation.Root({ value: Annotation<number> });
  const runtime = createRuntime({ appId: 'tests', executors: [createLangGraphAdapter()] });
  const instance = await runtime.create(definition, {
    principalScope: 'user',
    services: { chatModels: {} },
    agent: (host) =>
      new StateGraph(state)
        .addNode('a', ({ value }) => ({ value: value + 1 }))
        .addEdge(START, 'a')
        .addEdge('a', END)
        .compile({ checkpointer: host.langchain.checkpointer() }),
  });
  await instance.prepare();
  const { runId } = await instance.start({ value: 1 });
  const events = await collect(instance.events(runId));
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'stream',
      executor: 'langgraph-js',
      path: [],
      mode: 'values',
      data: { value: 2 },
    }),
  );
  expect(events.at(-1)).toMatchObject({ type: 'output', output: { value: 2 } });
  expect(instance.getSnapshot().run?.status).toBe('succeeded');
  await runtime.dispose();
});

test('advertises the adapter package version and only the implemented features', () => {
  const adapter = createLangGraphAdapter();
  expect(adapter.version).toBe(adapterMetadata.version);
  expect(adapter.features).toEqual({
    interrupts: false,
    resume: false,
    checkpoints: false,
    streaming: true,
    subgraphs: true,
  });
  expect(STREAM_MODES).toEqual(['values', 'updates', 'messages', 'custom']);
});

test('streams model, custom, values and updates with the exact node and model span tree', async () => {
  const model = new ScriptedChatModel({
    hello: {
      id: 'reply-hello',
      text: 'fixture answer',
      usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
    },
  });
  const state = Annotation.Root({ value: Annotation<number>, answer: Annotation<string> });
  let factoryCalls = 0;
  const fixture = await ready(
    (host) => {
      factoryCalls++;
      const chat = host.langchain.chatModel('assistant');
      return new StateGraph(state)
        .addNode('a', async ({ value }, config) => {
          config.writer?.({ phase: 'a' });
          const answer = await chat.invoke(
            [new HumanMessage({ id: 'human-hello', content: 'hello' })],
            config,
          );
          return { value: value + 1, answer: answer.content };
        })
        .addNode('b', ({ value }) => ({ value: value * 2 }))
        .addEdge(START, 'a')
        .addEdge('a', 'b')
        .addEdge('b', END)
        .compile({ checkpointer: host.langchain.checkpointer() });
    },
    { chatModels: { assistant: model } },
  );
  const { runId } = await fixture.instance.start({ value: 1 });
  const events = await collect(fixture.instance.events(runId));
  expect(factoryCalls).toBe(1);
  expect(events.at(-1)).toMatchObject({
    type: 'output',
    output: { value: 4, answer: 'fixture answer' },
  });
  expect(fixture.instance.getSnapshot().run?.status).toBe('succeeded');
  const chunks = events.filter((event) => event.type === 'stream');
  expect(new Set(chunks.map(({ mode }) => mode))).toEqual(new Set(STREAM_MODES));
  expect(chunks.every(({ executor }) => executor === 'langgraph-js')).toBe(true);
  expect(
    chunks
      .filter(({ mode }) => mode === 'values' || mode === 'updates')
      .every(({ path }) => path.length === 0),
  ).toBe(true);
  expect(chunks.filter(({ mode }) => mode === 'messages').map(({ path }) => path)).toEqual(
    expect.arrayContaining([expect.arrayContaining([expect.stringMatching(/^a:/)])]),
  );
  expect(chunks.find(({ mode }) => mode === 'custom')?.data).toEqual({ phase: 'a' });
  const messages = chunks
    .filter(({ mode }) => mode === 'messages')
    .map(({ data }) => data as [{ id: string; content: string }, unknown]);
  expect(messages.map(([message]) => message.content).join('')).toBe('fixture answer');
  expect(messages.map(([message]) => message.id)).toEqual(['reply-hello', 'reply-hello']);
  await fixture.runtime.dispose();
  await fixture.provider.forceFlush();
  const spans = fixture.exporter.getFinishedSpans();
  expect(assertSpanTree(spans)).toEqual({
    name: 'invoke_agent tests/langgraph',
    children: [
      { name: 'galaxie.node a', children: [{ name: 'chat fixture-1', children: [] }] },
      { name: 'galaxie.node b', children: [] },
    ],
  });
  expect(spans.find(({ name }) => name === 'chat fixture-1')?.attributes).toMatchObject({
    'gen_ai.provider.name': 'galaxie-fixture',
    'gen_ai.request.model': 'fixture-1',
    'gen_ai.usage.input_tokens': 7,
    'gen_ai.usage.output_tokens': 3,
  });
  expect(serializeSpans(spans)).not.toMatch(/hello|fixture answer|private-principal/);
  await fixture.provider.shutdown();
});

test('prepares once and continues one checkpointer thread across consecutive runs', async () => {
  const state = Annotation.Root({
    value: Annotation<number>,
    total: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
  });
  let factories = 0;
  let saver: BaseCheckpointSaver | undefined;
  const fixture = await ready((host) => {
    factories++;
    saver = host.langchain.checkpointer();
    expect(host.langchain.checkpointer()).toBe(saver);
    return new StateGraph(state)
      .addNode('add', ({ value }) => ({ total: value }))
      .addEdge(START, 'add')
      .addEdge('add', END)
      .compile({ checkpointer: saver });
  });
  const first = await fixture.instance.start({ value: 2 });
  expect((await collect(fixture.instance.events(first.runId))).at(-1)).toMatchObject({
    type: 'output',
    output: { value: 2, total: 2 },
  });
  const second = await fixture.instance.start({ value: 3 });
  expect((await collect(fixture.instance.events(second.runId))).at(-1)).toMatchObject({
    type: 'output',
    output: { value: 3, total: 5 },
  });
  expect(factories).toBe(1);
  await fixture.runtime.dispose();
  await fixture.provider.shutdown();
});

test('rejects missing model roles and malformed factory or services at preparation', async () => {
  const adapter = createLangGraphAdapter();
  const options = { signal: new AbortController().signal };
  await expect(
    adapter.prepare(
      (host) => {
        host.langchain.chatModel('missing');
        throw new Error('unreachable');
      },
      { chatModels: {} },
      options,
    ),
  ).rejects.toMatchObject({ code: 'unavailable' });
  await expect(
    adapter.prepare(null as unknown as LangGraphAgent, { chatModels: {} }, options),
  ).rejects.toMatchObject({ code: 'invalid' });
  await expect(
    adapter.prepare(() => ({}) as ReturnType<LangGraphAgent>, { chatModels: {} }, options),
  ).rejects.toMatchObject({ code: 'invalid' });
  await expect(
    adapter.prepare(
      () => {
        throw new Error('unreachable');
      },
      { chatModels: null } as unknown as LangGraphServices,
      options,
    ),
  ).rejects.toMatchObject({ code: 'invalid' });
  await expect(
    adapter.prepare(
      () => {
        throw new Error('unreachable');
      },
      { chatModels: { bad: {} } } as unknown as LangGraphServices,
      options,
    ),
  ).rejects.toMatchObject({ code: 'invalid' });
  await expect(
    adapter.prepare(
      () => {
        throw new Error('unreachable');
      },
      { chatModels: {}, checkpointer: {} } as LangGraphServices,
      options,
    ),
  ).rejects.toMatchObject({ code: 'invalid' });
});

test('reports NodeInterrupt and resume as unsupported', async () => {
  const state = Annotation.Root({ value: Annotation<number> });
  const fixture = await ready((host) =>
    new StateGraph(state)
      .addNode('pause', () => {
        throw new NodeInterrupt('pause');
      })
      .addEdge(START, 'pause')
      .addEdge('pause', END)
      .compile({ checkpointer: host.langchain.checkpointer() }),
  );
  const { runId } = await fixture.instance.start({ value: 1 });
  expect((await collect(fixture.instance.events(runId))).at(-1)).toMatchObject({
    type: 'error',
    error: { code: 'unsupported' },
  });
  expect(fixture.instance.getSnapshot().run?.status).toBe('failed');
  await fixture.runtime.dispose();
  await fixture.provider.shutdown();
  const agent = await createLangGraphAdapter().prepare(
    () => ({
      stream: async () => {
        throw new Error('must not run');
      },
      transform: () => {
        throw new Error('must not run');
      },
    }),
    { chatModels: {} },
    { signal: new AbortController().signal },
  );
  const request = {
    command: { type: 'resume', interactionId: 'interaction', payload: {} },
    signal: new AbortController().signal,
  } as RunRequest;
  expect(await collect(agent.run(request))).toEqual([
    { type: 'error', error: expect.objectContaining({ code: 'unsupported' }) },
  ]);
  await agent.dispose();
});

test('rejects stream-only facades without a drainable native transform', async () => {
  const adapter: ExecutorAdapter<unknown, LangGraphServices> = createLangGraphAdapter();
  const factory = () => ({
    stream: async () => ({
      async *[Symbol.asyncIterator]() {
        yield [];
      },
    }),
  });
  await expect(
    adapter.prepare(factory, { chatModels: {} }, { signal: new AbortController().signal }),
  ).rejects.toMatchObject({ code: 'unsupported' });
});

test.each(['node', 'model', 'abort-name'] as const)(
  'sanitizes a %s failure and sends the raw error only to diagnostics',
  async (kind) => {
    const raw = kind === 'model' ? new FixtureModelError('secret-model') : new Error('secret-node');
    if (kind === 'abort-name') raw.name = 'AbortError';
    const diagnostics: DiagnosticEvent[] = [];
    const model = new ScriptedChatModel({ fail: { error: raw as FixtureModelError } });
    const state = Annotation.Root({ value: Annotation<number> });
    const fixture = await ready(
      (host) =>
        new StateGraph(state)
          .addNode('fail', async (_state, config) => {
            if (kind === 'model')
              await host.langchain
                .chatModel('assistant')
                .invoke([new HumanMessage({ id: 'human-fail', content: 'fail' })], config);
            else throw raw;
            return {};
          })
          .addEdge(START, 'fail')
          .addEdge('fail', END)
          .compile(),
      { chatModels: { assistant: model } },
      (event) => diagnostics.push(event),
    );
    const { runId } = await fixture.instance.start({ value: 1 });
    const events = await collect(fixture.instance.events(runId));
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      error: {
        code: 'executor_error',
        type: raw.name,
        message: 'The executor or agent code failed.',
      },
    });
    expect(fixture.instance.getSnapshot().run?.status).toBe('failed');
    expect(diagnostics.find(({ kind: eventKind }) => eventKind === 'run_failed')?.error).toBe(raw);
    await fixture.runtime.dispose();
    await fixture.provider.forceFlush();
    const spans = fixture.exporter.getFinishedSpans();
    assertSpanTree(spans);
    expect(
      JSON.stringify({ events, snapshot: fixture.instance.getSnapshot() }) + serializeSpans(spans),
    ).not.toContain('secret-');
    expect(spans.every(({ status }) => status.message === undefined)).toBe(true);
    await fixture.provider.shutdown();
  },
);

test('preserves the native recursion error type', async () => {
  const state = Annotation.Root({ value: Annotation<number> });
  const fixture = await ready(() =>
    new StateGraph(state)
      .addNode('loop', ({ value }) => ({ value: value + 1 }))
      .addEdge(START, 'loop')
      .addEdge('loop', 'loop')
      .compile()
      .withConfig({ recursionLimit: 3 }),
  );
  const { runId } = await fixture.instance.start({ value: 0 });
  expect((await collect(fixture.instance.events(runId))).at(-1)).toMatchObject({
    type: 'error',
    error: { code: 'executor_error', type: 'GraphRecursionError' },
  });
  await fixture.runtime.dispose();
  await fixture.provider.shutdown();
});

class DelayedSaver extends MemorySaver {
  readonly blocked = deferred<void>();
  readonly release = deferred<void>();
  readonly writesSeen: Array<{ id: string; parent: unknown; step: number; source: string }> = [];
  delay = true;

  override async put(...args: Parameters<MemorySaver['put']>): ReturnType<MemorySaver['put']> {
    if (this.delay) {
      this.blocked.resolve();
      await this.release.promise;
    }
    const result = await super.put(...args);
    this.writesSeen.push({
      id: args[1].id,
      parent: args[0].configurable?.['checkpoint_id'],
      step: args[2].step,
      source: args[2].source,
    });
    return result;
  }
}

class RootObserver extends BaseCallbackHandler {
  override name: string = 'root-observer';
  override awaitHandlers: boolean = true;
  readonly ended = deferred<void>();
  #root: string | undefined;
  override handleChainStart(
    _chain: unknown,
    _inputs: unknown,
    runId: string,
    parentRunId?: string,
  ): void {
    if (parentRunId === undefined) this.#root = runId;
  }
  override handleChainEnd(_output: unknown, runId: string): void {
    if (runId === this.#root) this.ended.resolve();
  }
  override handleChainError(_error: Error, runId: string): void {
    if (runId === this.#root) this.ended.resolve();
  }
}

function cancellationGraph(
  model: ScriptedChatModel,
  saver: BaseCheckpointSaver,
  observer: RootObserver,
) {
  const state = Annotation.Root({ value: Annotation<number>, answer: Annotation<string> });
  return new StateGraph(state)
    .addNode('model', async ({ value }, config: LangGraphRunnableConfig) => ({
      answer: (
        await model.invoke(
          [new HumanMessage({ id: `human-${value}`, content: String(value) })],
          config,
        )
      ).content,
    }))
    .addEdge(START, 'model')
    .addEdge('model', END)
    .compile({ checkpointer: saver })
    .withConfig({ callbacks: [observer] });
}

test('keeps a successor queued until abort callbacks and checkpoint writes settle without forking the thread', async () => {
  const latch = createModelLatch();
  const saver = new DelayedSaver();
  const observer = new RootObserver();
  const model = new ScriptedChatModel({
    '1': {
      id: 'reply-1',
      text: 'first',
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      wait: latch,
    },
    '2': {
      id: 'reply-2',
      text: 'second',
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    },
  });
  const graph = cancellationGraph(model, saver, observer);
  const fixture = await ready(() => graph, {
    chatModels: { assistant: model },
    checkpointer: saver,
  });
  const first = await fixture.instance.start({ value: 1 });
  await Promise.all([latch.entered, saver.blocked.promise]);
  const firstEvents = collect(fixture.instance.events(first.runId));
  expect(await fixture.instance.cancel(first.runId)).toMatchObject({ status: 'cancelled' });
  expect((await firstEvents).at(-1)).toMatchObject({ type: 'cancelled' });
  const second = await fixture.instance.start({ value: 2 });
  const secondEvents = collect(fixture.instance.events(second.runId));
  await flush();
  expect(fixture.instance.getSnapshot().run?.status).toBe('queued');
  let rootEnded = false;
  void observer.ended.promise.then(() => {
    rootEnded = true;
  });
  await flush();
  expect(rootEnded).toBe(false);
  saver.delay = false;
  saver.release.resolve();
  await observer.ended.promise;
  expect((await secondEvents).at(-1)).toMatchObject({
    type: 'output',
    output: { value: 2, answer: 'second' },
  });
  const parents = saver.writesSeen
    .map(({ parent }) => parent)
    .filter((parent) => parent !== undefined);
  expect(new Set(parents).size).toBe(parents.length);
  for (const [index, checkpoint] of saver.writesSeen.entries()) {
    if (index > 0) expect(checkpoint.parent).toBe(saver.writesSeen[index - 1]?.id);
  }
  const secondInput = saver.writesSeen.findIndex(
    ({ source }, index) => index > 0 && source === 'input',
  );
  expect(secondInput).toBeGreaterThan(0);
  expect(saver.writesSeen[secondInput]?.parent).toBe(saver.writesSeen[secondInput - 1]?.id);
  const thread = Object.keys(saver.storage);
  expect(thread).toHaveLength(1);
  const history = await collect(graph.getStateHistory({ configurable: { thread_id: thread[0] } }));
  expect(history).toHaveLength(saver.writesSeen.length);
  expect(history[0]?.values).toEqual({ value: 2, answer: 'second' });
  for (const [index, checkpoint] of history.entries()) {
    expect(checkpoint.parentConfig?.configurable?.['checkpoint_id']).toBe(
      history[index + 1]?.config.configurable?.['checkpoint_id'],
    );
  }
  await fixture.runtime.dispose();
  await fixture.provider.shutdown();
});

test('core alone bounds a never-settled predecessor and disposal at ten seconds', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const latch = createModelLatch();
    const saver = new DelayedSaver();
    const observer = new RootObserver();
    const model = new ScriptedChatModel({
      '1': {
        id: 'reply-1',
        text: 'first',
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        wait: latch,
      },
    });
    const fixture = await ready(() => cancellationGraph(model, saver, observer), {
      chatModels: { assistant: model },
      checkpointer: saver,
    });
    const first = await fixture.instance.start({ value: 1 });
    await Promise.all([latch.entered, saver.blocked.promise]);
    await fixture.instance.cancel(first.runId);
    const second = await fixture.instance.start({ value: 2 });
    const events = collect(fixture.instance.events(second.runId));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fixture.instance.getSnapshot().run?.status).toBe('queued');
    await vi.advanceTimersByTimeAsync(1);
    expect((await events).at(-1)).toMatchObject({ type: 'error', error: { code: 'timeout' } });
    const disposal = fixture.runtime.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    await disposal;
    expect(fixture.instance.getSnapshot().state).toBe('disposed');
    expect(saver.writesSeen).toEqual([]);
    await fixture.provider.shutdown();
  } finally {
    vi.useRealTimers();
  }
});
