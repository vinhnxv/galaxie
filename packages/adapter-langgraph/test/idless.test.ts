// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  type ExecutorEvent,
  GalaxieError,
  type InteractionId,
  type RunCommand,
  type RunRequest,
  type SessionId,
  toErrorInfo,
} from '@galaxie-ai/core';
import type { StateSnapshot } from '@langchain/langgraph/web';
import { expect, test, vi } from 'vitest';
import { createLangGraphAdapter } from '../src/adapter.js';
import type { LangGraphGraph } from '../src/host.js';

const taskId = 'ec4b3ae8-7d3a-493e-80c3-2360165681ae';
const nullTask = '00000000-0000-0000-0000-000000000000';
const sessionId = 'session' as SessionId;
const interactionId = `idless:${taskId}:0` as InteractionId;
const question = {
  surfaceId: 'main',
  viewRevision: 'revision',
  component: 'tests.Question/v1',
  props: { question: 'private-question-canary' },
};
type Tasks = StateSnapshot['tasks'];
type Write = [string, string, unknown];

function fixture(
  tasks: Tasks = [{ id: taskId, name: 'private-node-canary', interrupts: [{ value: question }] }],
  writes: Write[] | undefined = [[taskId, '__interrupt__', [{ value: question }]]],
) {
  const getTuple = vi.fn(async () =>
    writes === undefined ? undefined : { pendingWrites: writes },
  );
  const getState = vi.fn(async () => ({ tasks }));
  const transform = vi.fn<LangGraphGraph['transform']>(async function* () {
    yield [[], 'updates', { __interrupt__: [{ value: question }] }];
  });
  const graph: LangGraphGraph = {
    async stream() {
      return { async *[Symbol.asyncIterator]() {} };
    },
    transform,
    getState,
    ...{ checkpointer: { getTuple } },
  };
  return { graph, getState, getTuple, transform };
}

async function prepare(graph: LangGraphGraph) {
  return createLangGraphAdapter().prepare(
    () => graph,
    { chatModels: {} },
    {
      signal: new AbortController().signal,
    },
  );
}

function request(command: RunCommand, registerRestoredData?: (value: unknown) => void): RunRequest {
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
    ...(registerRestoredData === undefined ? {} : { registerRestoredData }),
  };
}

async function events(graph: LangGraphGraph, command: RunCommand): Promise<ExecutorEvent[]> {
  const executor = await prepare(graph);
  return collect(executor.run(request(command)));
}

async function collect(source: AsyncIterable<ExecutorEvent>): Promise<ExecutorEvent[]> {
  const result: ExecutorEvent[] = [];
  for await (const event of source) result.push(event);
  return result;
}

async function refused(graph: LangGraphGraph): Promise<void> {
  const executor = await prepare(graph);
  const error = await executor.pending(sessionId).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(GalaxieError);
  expect(error).toMatchObject(toErrorInfo('unsupported'));
  expect(String(error)).not.toContain('private-question-canary');
  expect(String(error)).not.toContain('private-node-canary');
  const result = await collect(executor.run(request({ type: 'start', input: {} })));
  expect(result.filter(({ type }) => type === 'interaction')).toEqual([]);
  expect(result.at(-1)).toMatchObject({ type: 'error', error: toErrorInfo('unsupported') });
}

test('reads a stable task-derived identity without needing a registration hook for an empty resume list', async () => {
  const { graph, getTuple } = fixture();
  const executor = await prepare(graph);
  for (let index = 0; index < 10; index++) {
    expect(await executor.pending(sessionId)).toEqual({ interactionId, ...question });
  }
  expect(getTuple).toHaveBeenCalledWith({ configurable: { thread_id: sessionId } });
});

test('registers every committed null-task and task resume before returning pending state', async () => {
  const answer = { action: 'submit', payload: 'private-answer-canary' };
  const { graph } = fixture(undefined, [
    [taskId, '__interrupt__', [{ value: question }]],
    [nullTask, '__resume__', answer],
    ['earlier-task', '__resume__', [false, { nested: answer }]],
  ]);
  const executor = await prepare(graph);
  await expect(executor.pending(sessionId)).rejects.toMatchObject(toErrorInfo('unsupported'));
  const order: unknown[] = [];
  const pending = await executor.pending(sessionId, {
    registerRestoredData: (value) => order.push(value),
  });
  order.push('returned');
  expect(order).toEqual([answer, false, { nested: answer }, 'returned']);
  expect(pending).toEqual({ interactionId, ...question });
});

test('a failed task with one consumed resume retains its original pending identity', async () => {
  const { graph } = fixture(
    [
      {
        id: taskId,
        name: 'gate',
        interrupts: [{ value: question }],
        error: { message: 'aborted' },
      },
    ],
    [
      [taskId, '__interrupt__', [{ value: question }]],
      [taskId, '__resume__', [{ action: 'submit', payload: 'yes' }]],
      [taskId, '__error__', { message: 'aborted' }],
    ],
  );
  const executor = await prepare(graph);
  const registered = vi.fn();
  expect(await executor.pending(sessionId, { registerRestoredData: registered })).toEqual({
    interactionId,
    ...question,
  });
  expect(registered).toHaveBeenCalledWith({ action: 'submit', payload: 'yes' });
});

test.each([null, '', 7])('refuses malformed interrupt ID %j', async (id) => {
  const { graph } = fixture([
    {
      id: taskId,
      name: 'gate',
      interrupts: [{ id, value: question } as Tasks[number]['interrupts'][number]],
    },
  ]);
  await refused(graph);
});

test.each([
  'private-question-canary',
  { foo: 1 },
  { ...question, extra: true },
  { protocol: 'galaxie.surface/1', surfaceId: 'main', revision: 1, model: {}, components: [] },
])('refuses a non-request interrupt value %j', async (value) => {
  await refused(fixture([{ id: taskId, name: 'gate', interrupts: [{ value }] }]).graph);
});

test.each(
  [
    [{ id: taskId, name: 'gate', interrupts: [{ value: question }, { value: question }] }],
    [
      {
        id: taskId,
        name: 'gate',
        interrupts: [{ value: question }, { id: 'raw', value: question }],
      },
    ],
    [
      { id: taskId, name: 'gate', interrupts: [{ value: question }] },
      { id: 'other', name: 'sibling', interrupts: [{ value: question }] },
    ],
    [
      {
        id: taskId,
        name: 'gate',
        interrupts: [{ value: question }],
        state: { configurable: { checkpoint_ns: 'child' } },
      },
    ],
    [
      { id: taskId, name: 'gate', interrupts: [{ value: question }] },
      { id: 'other', name: 'sibling', interrupts: [] },
    ],
  ].map((tasks) => ({ tasks })),
)('refuses ambiguous tasks and child checkpoints: %j', async ({ tasks }) => {
  await refused(fixture(tasks).graph);
});

test.each(
  [
    [],
    [['other', '__interrupt__', [{ value: question }]]],
    [
      [taskId, '__interrupt__', [{ value: question }]],
      [taskId, '__resume__', ['answer']],
    ],
    [
      [taskId, '__interrupt__', [{ value: question }]],
      ['other', '__error__', 'failed'],
    ],
    [
      [taskId, '__interrupt__', [{ value: question }]],
      ['other', '__interrupt__', []],
    ],
  ].map((writes) => ({ writes })),
)('refuses uncorroborated checkpoints and repeated calls: %j', async ({ writes }) => {
  const tasks = [{ id: taskId, name: 'gate', interrupts: [{ value: question }] }];
  if (writes.some(([id]) => id === 'other' && writes.length > 1))
    tasks.push({ id: 'other', name: 'sibling', interrupts: [] });
  await refused(fixture(tasks, writes as Write[]).graph);
});

test('refuses a missing checkpoint tuple and accepts only siblings with committed ordinary writes', async () => {
  const missing = fixture();
  missing.getTuple.mockResolvedValue(undefined);
  await refused(missing.graph);
  const good = fixture(
    [
      { id: taskId, name: 'gate', interrupts: [{ value: question }] },
      { id: 'other', name: 'sibling', interrupts: [] },
    ],
    [
      [taskId, '__interrupt__', [{ value: question }]],
      ['other', 'value', 1],
    ],
  );
  expect(await (await prepare(good.graph)).pending(sessionId)).toEqual({
    interactionId,
    ...question,
  });
});

test.each(['idless:forged:0', `idless:${taskId}:1`])(
  'rejects forged identity %s before transform',
  async (id) => {
    const { graph, transform } = fixture();
    expect(
      await events(graph, {
        type: 'resume',
        interactionId: id as InteractionId,
        action: 'submit',
        payload: 'yes',
      }),
    ).toEqual([{ type: 'error', error: expect.objectContaining(toErrorInfo('unsupported')) }]);
    expect(transform).not.toHaveBeenCalled();
  },
);

test.each([true, false])(
  'routes the exact %s ID-less resume shape without changing ID-bearing reads',
  async (idless) => {
    const id = idless ? interactionId : '0123456789abcdef';
    const { graph, transform, getState } = fixture(
      idless ? undefined : [{ id: taskId, name: 'gate', interrupts: [{ id, value: question }] }],
    );
    const inputs: unknown[] = [];
    transform.mockImplementation(async function* (source) {
      for await (const input of source) inputs.push(input);
      yield [[], 'values', { completed: true }];
    });
    const executor = await prepare(graph);
    const answer = { action: 'submit', payload: { answer: 'yes' } };
    const result = await collect(
      executor.run(request({ type: 'resume', interactionId: id as InteractionId, ...answer })),
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ resume: idless ? answer : { [id]: answer } });
    expect(JSON.stringify((inputs[0] as { resume: unknown }).resume)).toBe(
      JSON.stringify(idless ? answer : { [id]: answer }),
    );
    expect(getState).toHaveBeenCalledTimes(idless ? 1 : 0);
    expect(result.at(-1)).toEqual({ type: 'output', output: { completed: true } });
  },
);

test.each(['bearing', 'absent', 'committed-without-hook'] as const)(
  'rejects an ID-less resume against %s before graph execution',
  async (shape) => {
    const f = fixture();
    if (shape === 'bearing')
      f.getState.mockResolvedValue({
        tasks: [{ id: taskId, name: 'gate', interrupts: [{ id: 'raw', value: question }] }],
      });
    if (shape === 'absent') f.getState.mockResolvedValue({ tasks: [] });
    if (shape === 'committed-without-hook')
      f.getTuple.mockResolvedValue({
        pendingWrites: [
          [taskId, '__interrupt__', []],
          [nullTask, '__resume__', { action: 'submit', payload: 'private-answer-canary' }],
        ],
      });
    const result = await events(f.graph, {
      type: 'resume',
      interactionId,
      action: 'submit',
      payload: 'yes',
    });
    expect(result.at(-1)).toMatchObject({ type: 'error', error: toErrorInfo('unsupported') });
    expect(f.transform).not.toHaveBeenCalled();
  },
);

test.each([interactionId, '0123456789abcdef' as InteractionId])(
  'refuses a repeated identity or an ID-map answer to an ID-less pause: %s',
  async (id) => {
    const f = fixture();
    const result = await events(f.graph, {
      type: 'resume',
      interactionId: id,
      action: 'submit',
      payload: 'yes',
    });
    expect(f.transform).toHaveBeenCalledTimes(1);
    expect(result.filter(({ type }) => type === 'interaction')).toEqual([]);
    expect(result.at(-1)).toMatchObject({ type: 'error', error: toErrorInfo('unsupported') });
  },
);
