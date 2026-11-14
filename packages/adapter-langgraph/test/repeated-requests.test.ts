// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type {
  ExecutorEvent,
  InteractionId,
  RunCommand,
  RunRequest,
  SessionId,
} from '@galaxie-ai/core';
import { toErrorInfo } from '@galaxie-ai/core';
import { Annotation, END, MemorySaver, START, StateGraph } from '@langchain/langgraph/web';
import { expect, test, vi } from 'vitest';
import { createLangGraphAdapter } from '../src/adapter.js';
import { requestInteraction, requestSurface } from '../src/interaction.js';

const sessionId = 'repeated' as SessionId;
const question = {
  surfaceId: 'main',
  viewRevision: 'r1',
  component: 'tests.Question/v1',
  props: { question: 'private-question-canary' },
};
const answer = { action: 'submit', payload: 'private-answer-canary' };
const surface = {
  format: 'galaxie.surface/1',
  region: 'main',
  a2uiSurfaceId: 'question',
  catalogId: 'tests',
  revision: 1,
  specVersion: '0.8',
  specRevision: 'test',
  status: 'live',
  components: { root: { id: 'root', component: 'Question' } },
  dataModel: {},
};

function request(command: RunCommand): RunRequest {
  return {
    command,
    sessionId,
    runId: 'run' as RunRequest['runId'],
    signal: new AbortController().signal,
    limits: { steps: 20 },
    trace: { recordsText: false, start: () => ({ end() {} }) },
    capabilities: { call: async () => undefined },
    models: {
      begin: async () => {
        throw new Error('Unexpected model call.');
      },
    },
    registerRestoredData: () => {},
  };
}

async function collect(source: AsyncIterable<ExecutorEvent>): Promise<ExecutorEvent[]> {
  const events: ExecutorEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}

async function fixture(count = 2, failAfter?: number) {
  const saver = new MemorySaver();
  const entered = vi.fn();
  let failed = false;
  const graph = new StateGraph(Annotation.Root({ answers: Annotation<unknown[]> }))
    .addNode('questions', (_, config) => {
      entered();
      const answers = Array.from({ length: count }, (_, index) => {
        const value = requestInteraction({ ...question, viewRevision: `r${index + 1}` }, config);
        if (!failed && index + 1 === failAfter) {
          failed = true;
          throw new Error('private-error-canary');
        }
        return value;
      });
      return { answers };
    })
    .addEdge(START, 'questions')
    .addEdge('questions', END)
    .compile({ checkpointer: saver });
  const executor = await createLangGraphAdapter().prepare(
    () => graph,
    { chatModels: {} },
    {
      signal: new AbortController().signal,
    },
  );
  return { saver, graph, executor, entered };
}

test.each([1, 2])(
  'an errored task with %i committed answers keeps or refuses its identity',
  async (count) => {
    const { executor, graph, saver } = await fixture(count, count);
    await collect(executor.run(request({ type: 'start', input: {} })));
    const first = (await executor.pending(sessionId))!;
    let pending = first;
    for (let index = 0; index < count; index++) {
      const events = await collect(
        executor.run(request({ type: 'resume', interactionId: pending.interactionId, ...answer })),
      );
      if (index + 1 < count) {
        pending = (await executor.pending(sessionId, { registerRestoredData: () => {} }))!;
      } else
        expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'executor_error' } });
    }
    const config = { configurable: { thread_id: sessionId } };
    const task = (await graph.getState(config)).tasks[0]!;
    const writes = (await saver.getTuple(config))!.pendingWrites!;
    expect(writes).toContainEqual([
      task.id,
      '__resume__',
      Array.from({ length: count }, () => answer),
    ]);
    expect(writes.some(([id, channel]) => id === task.id && channel === '__error__')).toBe(true);
    const restored: unknown[] = [];
    const read = executor.pending(sessionId, {
      registerRestoredData: (value) => restored.push(value),
    });
    if (count === 1) {
      await expect(read).resolves.toEqual(first);
      expect(restored).toContainEqual(answer);
      const events = await collect(
        executor.run(request({ type: 'resume', interactionId: first.interactionId, ...answer })),
      );
      expect(events.at(-1)).toMatchObject({ type: 'output', output: { answers: [answer] } });
    } else await expect(read).rejects.toMatchObject(toErrorInfo('unsupported'));
  },
);

test('retrying an errored answered pause preserves its resume list and refuses the next question', async () => {
  const { executor, graph, saver } = await fixture(2, 1);
  await collect(executor.run(request({ type: 'start', input: {} })));
  const first = (await executor.pending(sessionId))!;
  const command = { type: 'resume', interactionId: first.interactionId, ...answer } as const;
  expect((await collect(executor.run(request(command)))).at(-1)).toMatchObject({
    type: 'error',
    error: { code: 'executor_error' },
  });
  const config = { configurable: { thread_id: sessionId } };
  const task = (await graph.getState(config)).tasks[0]!;
  const before = (await saver.getTuple(config))!.pendingWrites!;
  expect(before).toContainEqual([task.id, '__resume__', [answer]]);
  const events = await collect(executor.run(request(command)));
  expect(events.at(-1)).toMatchObject({ type: 'error', error: toErrorInfo('unsupported') });
  expect(events.some(({ type }) => type === 'interaction' || type === 'output')).toBe(false);
  expect(JSON.stringify(events.filter(({ type }) => type === 'error'))).not.toContain('private-');
  const state = await graph.getState(config);
  expect(state.values).toEqual({});
  expect(state.tasks[0]!.interrupts[0]!.value).toMatchObject({ viewRevision: 'r2' });
  const after = (await saver.getTuple(config))!.pendingWrites!;
  expect(after.filter(([id, channel]) => id === task.id && channel === '__resume__')).toEqual([
    [task.id, '__resume__', [answer]],
  ]);
  expect(after.filter(([id, channel]) => id === task.id && channel === '__error__')).toEqual(
    before.filter(([id, channel]) => id === task.id && channel === '__error__'),
  );
});

test('an errored retry refuses a new interrupt before parsing its request', async () => {
  const { executor, graph } = await fixture(2, 1);
  await collect(executor.run(request({ type: 'start', input: {} })));
  const first = (await executor.pending(sessionId))!;
  const command = { type: 'resume', interactionId: first.interactionId, ...answer } as const;
  await collect(executor.run(request(command)));
  const getState = graph.getState.bind(graph);
  vi.spyOn(graph, 'getState').mockImplementation(async (config) => {
    const state = await getState(config);
    return {
      ...state,
      tasks: state.tasks.map((task) => ({
        ...task,
        interrupts: task.interrupts.map((pause) => ({
          ...pause,
          value: (pause.value as { viewRevision: string }).viewRevision === 'r2' ? {} : pause.value,
        })),
      })),
    };
  });
  const events = await collect(executor.run(request(command)));
  expect(events.at(-1)).toMatchObject({ type: 'error', error: toErrorInfo('unsupported') });
  expect(events.some(({ type }) => type === 'interaction' || type === 'output')).toBe(false);
});

test('an error marker without a committed answer keeps the bare ID and accepts an ordinary resume', async () => {
  const { executor, graph, saver } = await fixture(1);
  await collect(executor.run(request({ type: 'start', input: {} })));
  const first = (await executor.pending(sessionId))!;
  const config = { configurable: { thread_id: sessionId } };
  const task = (await graph.getState(config)).tasks[0]!;
  const tuple = (await saver.getTuple(config))!;
  await saver.putWrites(
    tuple.config,
    [['__error__', { message: 'private-error-canary' }]],
    task.id,
  );
  expect(await executor.pending(sessionId)).toEqual(first);
  const events = await collect(
    executor.run(request({ type: 'resume', interactionId: first.interactionId, ...answer })),
  );
  expect(events.at(-1)).toMatchObject({ type: 'output', output: { answers: [answer] } });
});

test.each([2, 3])(
  'publishes %i questions with checkpoint-derived ordinals and routes bare-key answers',
  async (count) => {
    const { executor } = await fixture(count);
    const initial = await collect(executor.run(request({ type: 'start', input: {} })));
    expect(initial.at(-1)?.type).toBe('interaction');
    const first = await executor.pending(sessionId);
    expect(first).toBeDefined();
    const raw = first!.interactionId;
    for (let index = 0; index < count; index++) {
      const id = (index === 0 ? raw : `${raw}:${index}`) as InteractionId;
      const order: unknown[] = [];
      const pending = await executor.pending(sessionId, {
        registerRestoredData: (value) => order.push(value),
      });
      order.push('returned');
      expect(pending).toMatchObject({ interactionId: id, viewRevision: `r${index + 1}` });
      expect(order.at(-1)).toBe('returned');
      const registered = order.slice(0, -1).flat(Infinity);
      expect(registered.length).toBeGreaterThanOrEqual(index);
      for (const value of registered) expect(value).toEqual(answer);
      for (let read = 0; read < 10; read++)
        expect(await executor.pending(sessionId, { registerRestoredData: () => {} })).toEqual(
          pending,
        );
      if (index > 0)
        await expect(executor.pending(sessionId)).rejects.toMatchObject(toErrorInfo('unsupported'));
      const events = await collect(
        executor.run(request({ type: 'resume', interactionId: id, ...answer })),
      );
      expect(events.at(-1)).toMatchObject(
        index + 1 === count
          ? { type: 'output', output: { answers: Array.from({ length: count }, () => answer) } }
          : { type: 'interaction', interaction: { interactionId: `${raw}:${index + 1}` } },
      );
    }
    expect(await executor.pending(sessionId)).toBeUndefined();
  },
);

test('rejects forged and already-answered IDs before the node reexecutes', async () => {
  const { executor, entered } = await fixture();
  await collect(executor.run(request({ type: 'start', input: {} })));
  const first = (await executor.pending(sessionId))!;
  await collect(
    executor.run(request({ type: 'resume', interactionId: first.interactionId, ...answer })),
  );
  for (const id of [first.interactionId, `${first.interactionId}:5`]) {
    const calls = entered.mock.calls.length;
    const events = await collect(
      executor.run(request({ type: 'resume', interactionId: id as InteractionId, ...answer })),
    );
    expect(events).toEqual([
      { type: 'error', error: expect.objectContaining(toErrorInfo('unsupported')) },
    ]);
    expect(JSON.stringify(events)).not.toContain('private-');
    expect(entered).toHaveBeenCalledTimes(calls);
  }
});

test('reopening a saver with reversed pending writes preserves the second pause', async () => {
  const { saver, graph, executor } = await fixture();
  await collect(executor.run(request({ type: 'start', input: {} })));
  const first = (await executor.pending(sessionId))!;
  await collect(
    executor.run(request({ type: 'resume', interactionId: first.interactionId, ...answer })),
  );
  const reopened = new MemorySaver();
  reopened.storage = saver.storage;
  reopened.writes = saver.writes;
  const getTuple = reopened.getTuple.bind(reopened);
  vi.spyOn(reopened, 'getTuple').mockImplementation(async (config) => {
    const tuple = await getTuple(config);
    return tuple === undefined
      ? undefined
      : { ...tuple, pendingWrites: [...(tuple.pendingWrites ?? [])].reverse() };
  });
  const restored = await createLangGraphAdapter().prepare(
    () => graph,
    { chatModels: {}, checkpointer: reopened },
    {
      signal: new AbortController().signal,
    },
  );
  // The graph's own saver is authoritative, so reopen its read boundary too.
  vi.spyOn(saver, 'getTuple').mockImplementation((config) => reopened.getTuple(config));
  expect(await restored.pending(sessionId, { registerRestoredData: () => {} })).toMatchObject({
    interactionId: `${first.interactionId}:1`,
  });
});

test.each([
  'invalid',
  'surface',
  'completed',
  'child',
  'multiple',
  'parallel',
  'missing',
  'failed-read',
] as const)('fails closed for the %s checkpoint shape at a later ordinal', async (shape) => {
  const { saver, graph, executor } = await fixture();
  await collect(executor.run(request({ type: 'start', input: {} })));
  const first = (await executor.pending(sessionId))!;
  await collect(
    executor.run(request({ type: 'resume', interactionId: first.interactionId, ...answer })),
  );
  const config = { configurable: { thread_id: sessionId } };
  const state = await graph.getState(config);
  const task = state.tasks[0]!;
  if (shape === 'invalid' || shape === 'surface')
    vi.spyOn(graph, 'getState').mockResolvedValue({
      ...state,
      tasks: [
        {
          ...task,
          interrupts: [
            {
              id: first.interactionId,
              value: shape === 'invalid' ? { private: 'private-question-canary' } : surface,
            },
          ],
        },
      ],
    });
  if (shape === 'child')
    vi.spyOn(graph, 'getState').mockResolvedValue({
      ...state,
      tasks: [{ ...task, state: { configurable: { checkpoint_ns: 'child' } } }],
    });
  if (shape === 'multiple')
    vi.spyOn(graph, 'getState').mockResolvedValue({
      ...state,
      tasks: [{ ...task, interrupts: [...task.interrupts, ...task.interrupts] }],
    });
  if (shape === 'parallel')
    vi.spyOn(graph, 'getState').mockResolvedValue({
      ...state,
      tasks: [task, { ...task, id: 'sibling' }],
    });
  const tuple = (await saver.getTuple(config))!;
  if (shape === 'completed')
    vi.spyOn(saver, 'getTuple').mockResolvedValue({
      ...tuple,
      pendingWrites: [
        [task.id, '__resume__', [answer, answer]],
        [task.id, '__interrupt__', task.interrupts],
        [task.id, 'answers', [answer, answer]],
      ],
    });
  if (shape === 'missing' || shape === 'failed-read') {
    vi.spyOn(graph, 'getState').mockResolvedValue(state);
    if (shape === 'missing') vi.spyOn(saver, 'getTuple').mockResolvedValue(undefined);
    else vi.spyOn(saver, 'getTuple').mockRejectedValue(new Error('private-answer-canary'));
  }
  await expect(
    executor.pending(sessionId, { registerRestoredData: () => {} }),
  ).rejects.toMatchObject(
    shape === 'invalid'
      ? { code: 'invalid', message: 'The interaction request is invalid.' }
      : toErrorInfo('unsupported'),
  );
});

test('keeps an ordinal-zero surface on its existing publication path', async () => {
  const { graph, executor } = await fixture();
  await collect(executor.run(request({ type: 'start', input: {} })));
  const state = await graph.getState({ configurable: { thread_id: sessionId } });
  const task = state.tasks[0]!;
  vi.spyOn(graph, 'getState').mockResolvedValue({
    ...state,
    tasks: [{ ...task, interrupts: [{ id: 'raw', value: surface }] }],
  });
  expect(await executor.pending(sessionId)).toMatchObject({
    interactionId: 'raw',
    surface: { format: 'galaxie.surface/1' },
  });
});

test('an errored ordinal-zero surface keeps its bare ID and recovers on retry', async () => {
  const saver = new MemorySaver();
  let failed = false;
  const graph = new StateGraph(Annotation.Root({ answers: Annotation<unknown[]> }))
    .addNode('surface', (_, config) => {
      const submitted = requestSurface(surface, config);
      if (!failed) {
        failed = true;
        throw new Error('private-error-canary');
      }
      return { answers: [submitted] };
    })
    .addEdge(START, 'surface')
    .addEdge('surface', END)
    .compile({ checkpointer: saver });
  const executor = await createLangGraphAdapter().prepare(
    () => graph,
    { chatModels: {} },
    { signal: new AbortController().signal },
  );
  await collect(executor.run(request({ type: 'start', input: {} })));
  const first = (await executor.pending(sessionId))!;
  expect(first.surface).toMatchObject({ format: 'galaxie.surface/1' });
  const command = { type: 'resume', interactionId: first.interactionId, ...answer } as const;
  expect((await collect(executor.run(request(command)))).at(-1)).toMatchObject({
    type: 'error',
    error: { code: 'executor_error' },
  });
  expect(await executor.pending(sessionId, { registerRestoredData: () => {} })).toEqual(first);
  expect((await collect(executor.run(request(command)))).at(-1)).toMatchObject({
    type: 'output',
    output: { answers: [answer] },
  });
});

test('an aborted resume before the next question retains the committed pending identity', async () => {
  const saver = new MemorySaver();
  const entered = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  const graph = new StateGraph(Annotation.Root({ answers: Annotation<unknown[]> }))
    .addNode('questions', async (_, config) => {
      const first = requestInteraction(question, config);
      entered.resolve();
      await held.promise;
      config.signal?.throwIfAborted();
      return { answers: [first, requestInteraction({ ...question, viewRevision: 'r2' }, config)] };
    })
    .addEdge(START, 'questions')
    .addEdge('questions', END)
    .compile({ checkpointer: saver });
  const executor = await createLangGraphAdapter().prepare(
    () => graph,
    { chatModels: {} },
    { signal: new AbortController().signal },
  );
  await collect(executor.run(request({ type: 'start', input: {} })));
  const first = (await executor.pending(sessionId))!;
  const controller = new AbortController();
  const execution = collect(
    executor.run({
      ...request({ type: 'resume', interactionId: first.interactionId, ...answer }),
      signal: controller.signal,
    }),
  );
  await entered.promise;
  controller.abort();
  held.resolve();
  await execution;
  expect(await executor.pending(sessionId, { registerRestoredData: () => {} })).toEqual(first);
});
