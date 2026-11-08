// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { ExecutorAgent, ExecutorEvent } from '@galaxie-ai/core';
import { expect, test } from 'vitest';
import { createGoAdapter, type GoAgent } from '../src/index.js';
import {
  approvalRequest,
  FakeGoWorker,
  okResult,
  type Program,
  pausedResult,
} from './support-go.js';

const agent: GoAgent = {
  wasm: { url: 'http://127.0.0.1/go/agent.wasm', sha256: 'a'.repeat(64), bytes: 1024 },
  entry: 'reference',
};
const ids = ['1', '2', '3'].map((digit) => digit.repeat(64));

async function prepared(program: Program, stream = false) {
  const worker = new FakeGoWorker(program);
  const executor = await createGoAdapter({ createWorker: () => worker }).prepare(
    stream ? { ...agent, stream: true } : agent,
    { chatModels: {} },
    { signal: new AbortController().signal },
  );
  return { worker, executor };
}

async function drain(
  executor: ExecutorAgent,
  command: unknown,
  sessionId = 's',
  signal: AbortSignal = new AbortController().signal,
): Promise<ExecutorEvent[]> {
  const events: ExecutorEvent[] = [];
  for await (const event of executor.run({ signal, sessionId, command } as never))
    events.push(event);
  return events;
}
const start = { type: 'start', input: { prompt: 'go' } };
const resume = (interactionId: string, payload: unknown = { indexes: [0] }): unknown => ({
  type: 'resume',
  interactionId,
  action: 'approve',
  payload,
});

/** A program that pauses on a prompt and finishes on an answer, taking IDs in order. */
function pausingProgram(): Program {
  let paused = 0;
  return async (api) =>
    api.request.resume === undefined ? pausedResult(ids[paused++]) : okResult('answered');
}

test('a pause yields one interaction and pending reports it until it is answered', async () => {
  const { executor } = await prepared(pausingProgram());
  const events = await drain(executor, start);
  expect(events).toEqual([
    { type: 'interaction', interaction: { interactionId: ids[0], ...approvalRequest } },
  ]);
  await expect(executor.pending('s' as never)).resolves.toEqual({
    interactionId: ids[0],
    ...approvalRequest,
  });
  expect(await drain(executor, resume(ids[0] as string))).toEqual([
    { type: 'output', output: 'answered' },
  ]);
  await expect(executor.pending('s' as never)).resolves.toBeUndefined();
});

test('a resume reaches the program as the answer to the pause, with no prompt', async () => {
  const { executor, worker } = await prepared(pausingProgram());
  await drain(executor, start);
  await drain(executor, resume(ids[0] as string, { indexes: [0, 1] }));
  const sent = worker.received.filter((message) => message.kind === 'run');
  expect(sent.map((message) => JSON.parse(message.request))).toEqual([
    { entry: 'reference', prompt: 'go', conversation: 'g1' },
    {
      entry: 'reference',
      prompt: '',
      conversation: 'g1',
      resume: { interactionId: ids[0], action: 'approve', payload: { indexes: [0, 1] } },
    },
  ]);
});

test('a resume with no payload omits it', async () => {
  const { executor, worker } = await prepared(pausingProgram());
  await drain(executor, start);
  await drain(executor, { type: 'resume', interactionId: ids[0], action: 'approve' });
  const request = JSON.parse(
    worker.received.filter((message) => message.kind === 'run')[1]?.request ?? '{}',
  );
  expect(request.resume).toEqual({ interactionId: ids[0], action: 'approve' });
});

test.each([
  ['an unknown interaction', ids[2]],
  ['a digest of the wrong length', 'abc'],
])('a resume for %s fails stale and keeps the pause', async (_name, interactionId) => {
  const { executor, worker } = await prepared(pausingProgram());
  await drain(executor, start);
  expect(await drain(executor, resume(interactionId as string))).toMatchObject([
    { type: 'error', error: { code: 'stale' } },
  ]);
  expect(worker.received.filter((message) => message.kind === 'run')).toHaveLength(1);
  await expect(executor.pending('s' as never)).resolves.toMatchObject({ interactionId: ids[0] });
});

test('a resume with no pause fails stale', async () => {
  const { executor } = await prepared(pausingProgram());
  expect(await drain(executor, resume(ids[0] as string))).toMatchObject([
    { type: 'error', error: { code: 'stale' } },
  ]);
});

test('an answered pause cannot be answered again', async () => {
  const { executor } = await prepared(pausingProgram());
  await drain(executor, start);
  await drain(executor, resume(ids[0] as string));
  expect(await drain(executor, resume(ids[0] as string))).toMatchObject([
    { type: 'error', error: { code: 'stale' } },
  ]);
});

test('a new prompt drops the pause it replaces', async () => {
  const { executor } = await prepared(pausingProgram());
  await drain(executor, start);
  await drain(executor, start);
  await expect(executor.pending('s' as never)).resolves.toMatchObject({ interactionId: ids[1] });
  expect(await drain(executor, resume(ids[0] as string))).toMatchObject([
    { type: 'error', error: { code: 'stale' } },
  ]);
});

test('pauses are kept per session', async () => {
  const { executor } = await prepared(pausingProgram());
  await drain(executor, start, 'one');
  await drain(executor, start, 'two');
  await expect(executor.pending('one' as never)).resolves.toMatchObject({ interactionId: ids[0] });
  await expect(executor.pending('two' as never)).resolves.toMatchObject({ interactionId: ids[1] });
  expect(await drain(executor, resume(ids[1] as string), 'one')).toMatchObject([
    { type: 'error', error: { code: 'stale' } },
  ]);
});

test('a resume whose payload cannot be sent fails invalid and consumes the pause', async () => {
  const { executor } = await prepared(pausingProgram());
  await drain(executor, start);
  const cyclic: Record<string, unknown> = {};
  cyclic['self'] = cyclic;
  expect(await drain(executor, resume(ids[0] as string, cyclic))).toMatchObject([
    { type: 'error', error: { code: 'invalid' } },
  ]);
  await expect(executor.pending('s' as never)).resolves.toBeUndefined();
});

test('a malformed pause fails invalid and stores nothing', async () => {
  const { executor } = await prepared(async () =>
    pausedResult(ids[0], { ...approvalRequest, extra: 1 }),
  );
  expect(await drain(executor, start)).toMatchObject([
    { type: 'error', error: { code: 'invalid' } },
  ]);
  await expect(executor.pending('s' as never)).resolves.toBeUndefined();
});

test('a run cancelled before its pause arrives stores no pause', async () => {
  const controller = new AbortController();
  const { executor } = await prepared(async () => {
    controller.abort();
    return pausedResult(ids[0]);
  });
  expect(await drain(executor, start, 's', controller.signal)).toEqual([]);
  await expect(executor.pending('s' as never)).resolves.toBeUndefined();
});

test('a Worker that dies leaves no pause and the session unrecoverable', async () => {
  const { executor, worker } = await prepared(pausingProgram());
  await drain(executor, start);
  worker.emit({ v: 1, kind: 'exit', code: 1 });
  await expect(executor.pending('s' as never)).resolves.toBeUndefined();
  expect(await drain(executor, resume(ids[0] as string))).toMatchObject([
    { type: 'error', error: { code: 'unrecoverable' } },
  ]);
});

test('a streaming pause ends with one content-free marker and positions continue on resume', async () => {
  const { executor } = await prepared(pausingProgram(), true);
  const first = await drain(executor, start);
  expect(first.map((event) => event.type)).toEqual(['stream', 'interaction']);
  expect(first[0]).toMatchObject({
    mode: 'updates',
    data: { step: 'paused', index: 0 },
  });
  expect(JSON.stringify(first[0])).not.toContain(approvalRequest.surfaceId);
  const second = await drain(executor, resume(ids[0] as string));
  expect(second).toEqual([{ type: 'output', output: 'answered' }]);
  const again = await drain(executor, start);
  expect(again[0]).toMatchObject({ data: { step: 'paused', index: 0 } });
});

test('a pausing program that streams nothing emits no marker without a stream', async () => {
  const { executor } = await prepared(pausingProgram());
  expect((await drain(executor, start)).map((event) => event.type)).toEqual(['interaction']);
});
