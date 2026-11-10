// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import type { RunId } from '../src/index.js';
import { collect, deferred, flush, ready, stream } from './fake-executor.js';

test('stream events are live only and terminal events replay with their original sequence', async () => {
  const gate = deferred<void>();
  const { instance, runtime } = await ready([
    [
      ...Array.from({ length: 5 }, (_, index) => stream(index)),
      { wait: gate.promise },
      stream('live'),
      { type: 'output', output: 'done' },
    ],
  ]);
  const { runId } = await instance.start('input');
  await flush();
  const iterator = instance.events(runId)[Symbol.asyncIterator]();
  const live = iterator.next();
  gate.resolve();
  const liveResult = await live;
  expect(liveResult).toMatchObject({ value: { type: 'stream', sequence: 5, data: 'live' } });
  const output = await iterator.next();
  expect(output).toMatchObject({ value: { type: 'output', sequence: 6 } });
  expect(output.value?.eventId).not.toBe(liveResult.value?.eventId);
  await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  expect(await collect(instance.events(runId))).toEqual([output.value]);
  await runtime.dispose();
});

test('a slow event consumer fails without blocking another consumer or losing terminal replay', async () => {
  const gate = deferred<void>();
  const { instance, runtime } = await ready([
    [
      { wait: gate.promise },
      ...Array.from({ length: 2048 }, (_, index) => stream(index)),
      { type: 'output', output: 'done' },
    ],
  ]);
  try {
    const { runId } = await instance.start('input');
    const slow = instance.events(runId)[Symbol.asyncIterator]();
    const first = slow.next();
    const following = collect(instance.events(runId));
    gate.resolve();
    await expect(first).resolves.toMatchObject({ value: { type: 'stream', sequence: 0 } });
    const events = await following;
    expect(events).toHaveLength(2049);
    expect(events.at(-1)).toMatchObject({ type: 'output', output: 'done', sequence: 2048 });
    await expect(slow.next()).rejects.toMatchObject({
      code: 'budget_exceeded',
      message: 'The budget limit was reached.',
    });
    await expect(slow.next()).resolves.toEqual({ done: true, value: undefined });
    expect(instance.getSnapshot().run?.status).toBe('succeeded');
    expect(await collect(instance.events(runId))).toEqual([events.at(-1)]);
  } finally {
    gate.resolve();
    await runtime.dispose();
  }
});

test('consumer return immediately detaches and resolves outstanding next calls', async () => {
  const gate = deferred<void>();
  const { instance, runtime } = await ready([
    [{ wait: gate.promise }, { type: 'output', output: 'done' }],
  ]);
  const { runId } = await instance.start('input');
  const iterator = instance.events(runId)[Symbol.asyncIterator]();
  const pending = iterator.next();
  const otherPending = iterator.next();
  await expect(iterator.return?.()).resolves.toEqual({ done: true, value: undefined });
  await expect(pending).resolves.toEqual({ done: true, value: undefined });
  await expect(otherPending).resolves.toEqual({ done: true, value: undefined });
  await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  expect(instance.getSnapshot().run?.status).toBe('running');
  gate.resolve();
  await flush();
  expect(instance.getSnapshot().run?.status).toBe('succeeded');
  await runtime.dispose();
});

test('breaking one consumer leaves other consumers and the executor attached', async () => {
  const gate = deferred<void>();
  const { instance, executor, runtime } = await ready([
    [stream('first'), { wait: gate.promise }, stream('second'), { type: 'output', output: 'done' }],
  ]);
  const { runId } = await instance.start('input');
  const following = instance.events(runId)[Symbol.asyncIterator]();
  const leaving = instance.events(runId)[Symbol.asyncIterator]();
  const first = leaving.next();
  await expect(following.next()).resolves.toMatchObject({ value: { sequence: 0 } });
  const pending = following.next();
  expect((await first).value?.sequence).toBe(0);
  await leaving.return?.();
  expect(instance.getSnapshot().run?.status).toBe('running');
  gate.resolve();
  await expect(pending).resolves.toMatchObject({ value: { sequence: 1, data: 'second' } });
  await expect(following.next()).resolves.toMatchObject({ value: { type: 'output', sequence: 2 } });
  await expect(following.next()).resolves.toMatchObject({ done: true });
  expect(executor.iteratorReturns).toBe(0);
  await runtime.dispose();
});

test('stale event IDs reject on first next, including an iterable created before a new run', async () => {
  const { instance, runtime } = await ready();
  await expect(
    instance
      .events('missing' as RunId)
      [Symbol.asyncIterator]()
      .next(),
  ).rejects.toMatchObject({ code: 'stale' });
  const first = await instance.start('first');
  await flush();
  const earlier = instance.events(first.runId)[Symbol.asyncIterator]();
  await instance.start('second');
  await expect(earlier.next()).rejects.toMatchObject({ code: 'stale' });
  await expect(earlier.next()).resolves.toMatchObject({ done: true });
  await expect(instance.events(first.runId)[Symbol.asyncIterator]().next()).rejects.toMatchObject({
    code: 'stale',
  });
  await runtime.dispose();
});

test('stream payloads pass by reference while event identity stays immutable', async () => {
  const data = { values: ['first'] };
  const { instance, runtime } = await ready([[stream(data), { type: 'output', output: 'done' }]]);
  const { runId } = await instance.start('input');
  const events = await collect(instance.events(runId));
  const event = events[0];
  expect(event?.type).toBe('stream');
  if (event?.type !== 'stream') throw new Error('Expected a stream event.');
  expect(event.data).toBe(data);
  expect(Object.isFrozen(event)).toBe(true);
  expect(Object.isFrozen(data)).toBe(false);
  data.values.push('second');
  expect(event.data).toEqual({ values: ['first', 'second'] });
  await runtime.dispose();
});
