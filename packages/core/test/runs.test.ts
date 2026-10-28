// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import {
  createRuntime,
  type DiagnosticEvent,
  type ErrorCode,
  GalaxieError,
  type InteractionId,
  type PendingInteraction,
  type RunId,
  type ViewRevision,
} from '../src/index.js';
import {
  collect,
  deferred,
  definition,
  FakeExecutor,
  flush,
  ready,
  stream,
} from './fake-executor.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('adapter error causes reach diagnostics without entering stored errors', async () => {
  const raw = new TypeError('secret-adapter-cause');
  const envelope = Object.assign(
    new GalaxieError('executor_error', 'The executor or agent code failed.', { cause: raw }),
    { type: 'TypeError' },
  );
  const diagnostics: DiagnosticEvent[] = [];
  const runtime = createRuntime({
    appId: 'tests',
    executors: [new FakeExecutor([[{ type: 'error', error: envelope }]])],
    diagnostics: (event) => diagnostics.push(event),
  });
  const instance = await runtime.create(definition, { principalScope: 'user', agent: {} });
  await instance.prepare();
  const { runId } = await instance.start('input');
  const events = await collect(instance.events(runId));
  await runtime.dispose();
  expect(diagnostics).toContainEqual(expect.objectContaining({ kind: 'run_failed', error: raw }));
  expect(JSON.stringify({ snapshot: instance.getSnapshot(), events })).not.toContain(
    'secret-adapter-cause',
  );
  expect(instance.getSnapshot().run?.error?.type).toBe('TypeError');
});

test('two starts in one tick claim one slot before asynchronous schema validation', async () => {
  const validation = deferred<void>();
  const executor = new FakeExecutor();
  const runtime = createRuntime({ appId: 'tests', executors: [executor] });
  const instance = await runtime.create(
    {
      ...definition,
      input: z.string().refine(async () => {
        await validation.promise;
        return true;
      }),
    },
    { principalScope: 'user', agent: {} },
  );
  await instance.prepare();
  const ids = vi.spyOn(globalThis.crypto, 'randomUUID');
  const first = instance.start('first');
  await expect(instance.start('second')).rejects.toMatchObject({ code: 'invalid' });
  expect(instance.getSnapshot().run).toBeUndefined();
  expect(ids).not.toHaveBeenCalled();
  validation.resolve();
  const { runId } = await first;
  await flush();
  expect(instance.getSnapshot().run?.runId).toBe(runId);
  expect(executor.requests).toHaveLength(1);
  expect(executor.requests[0]?.command).toEqual({ type: 'start', input: 'first' });
  await runtime.dispose();
});

test('invalid input leaves the snapshot unchanged and allocates no run ID', async () => {
  const { instance, runtime, executor } = await ready();
  const snapshot = instance.getSnapshot();
  const ids = vi.spyOn(globalThis.crypto, 'randomUUID');
  await expect(instance.start(42 as unknown as string)).rejects.toMatchObject({ code: 'invalid' });
  expect(instance.getSnapshot()).toBe(snapshot);
  expect(ids).not.toHaveBeenCalled();
  expect(executor.requests).toHaveLength(0);
  await runtime.dispose();
});

test('a schema-thrown GalaxieError is an invalid input failure with no run ID', async () => {
  const executor = new FakeExecutor();
  const runtime = createRuntime({ appId: 'tests', executors: [executor] });
  const instance = await runtime.create(
    {
      ...definition,
      input: z.string().transform(() => {
        throw new GalaxieError('denied', 'secret');
      }),
    },
    { principalScope: 'user', agent: {} },
  );
  await instance.prepare();
  const ids = vi.spyOn(globalThis.crypto, 'randomUUID');
  await expect(instance.start('input')).rejects.toMatchObject({
    code: 'invalid',
    message: 'The run input failed validation.',
  });
  expect(instance.getSnapshot().run).toBeUndefined();
  expect(ids).not.toHaveBeenCalled();
  await runtime.dispose();
});

test('the executor receives the Standard Schema transformed value', async () => {
  const executor = new FakeExecutor();
  const runtime = createRuntime({ appId: 'tests', executors: [executor] });
  const instance = await runtime.create(
    { ...definition, input: z.string().transform((value) => value.length) },
    { principalScope: 'user', agent: {} },
  );
  await instance.prepare();
  await instance.start('four');
  await flush();
  expect(executor.requests[0]?.command).toEqual({ type: 'start', input: 4 });
  await runtime.dispose();
});

test('start rejects before ready and after dispose during validation', async () => {
  const executor = new FakeExecutor();
  const validation = deferred<void>();
  const runtime = createRuntime({ appId: 'tests', executors: [executor] });
  const instance = await runtime.create(
    {
      ...definition,
      input: z.string().refine(async () => {
        await validation.promise;
        return true;
      }),
    },
    { principalScope: 'user', agent: {} },
  );
  await expect(instance.start('input')).rejects.toMatchObject({ code: 'invalid' });
  await instance.prepare();
  const starting = instance.start('input');
  const rejected = expect(starting).rejects.toMatchObject({ code: 'invalid' });
  await instance.dispose();
  validation.resolve();
  await rejected;
  expect(instance.getSnapshot().run).toBeUndefined();
  expect(executor.requests).toHaveLength(0);
});

test('start resolves before an executor event and output ends the event stream', async () => {
  const gate = deferred<void>();
  const { instance, runtime } = await ready([
    [{ wait: gate.promise }, { type: 'output', output: { answer: 42 } }],
  ]);
  const { runId } = await instance.start('input');
  expect(instance.getSnapshot().run?.runId).toBe(runId);
  const events = instance.events(runId)[Symbol.asyncIterator]();
  const next = events.next();
  gate.resolve();
  await expect(next).resolves.toMatchObject({
    value: { type: 'output', output: { answer: 42 }, sequence: 0 },
  });
  await expect(events.next()).resolves.toEqual({ done: true, value: undefined });
  expect(instance.getSnapshot().run?.status).toBe('succeeded');
  await runtime.dispose();
});

test('executor throws become content-free failed snapshots and runtime error events', async () => {
  const raw = new TypeError('secret');
  const executor = new FakeExecutor([[{ throw: raw }]]);
  const diagnostics: DiagnosticEvent[] = [];
  const runtime = createRuntime({
    appId: 'tests',
    executors: [executor],
    diagnostics: (event) => diagnostics.push(event),
  });
  const instance = await runtime.create(definition, { principalScope: 'user', agent: {} });
  await instance.prepare();
  const { runId } = await instance.start('input');
  const events = await collect(instance.events(runId));
  expect(instance.getSnapshot().run).toMatchObject({
    status: 'failed',
    error: {
      code: 'executor_error',
      type: 'TypeError',
      message: 'The executor or agent code failed.',
    },
  });
  expect(events).toMatchObject([
    { type: 'error', error: { code: 'executor_error', type: 'TypeError' } },
  ]);
  expect(JSON.stringify([instance.getSnapshot(), events])).not.toContain('secret');
  expect(diagnostics).toContainEqual(
    expect.objectContaining({ kind: 'run_failed', runId, error: raw }),
  );
  await runtime.dispose();
});

test('an executor-thrown GalaxieError still represents an executor failure', async () => {
  const { instance, runtime } = await ready([[{ throw: new GalaxieError('cancelled', 'secret') }]]);
  await instance.start('input');
  await flush();
  expect(instance.getSnapshot().run).toMatchObject({
    status: 'failed',
    error: { code: 'executor_error' },
  });
  await runtime.dispose();
});

test('executor error events keep their code but sanitize their message and type', async () => {
  const raw = { code: 'unavailable' as const, message: 'secret', type: 'Invalid type' };
  const executor = new FakeExecutor([[{ type: 'error', error: raw }]]);
  const diagnostics: DiagnosticEvent[] = [];
  const runtime = createRuntime({
    appId: 'tests',
    executors: [executor],
    diagnostics: (event) => diagnostics.push(event),
  });
  const instance = await runtime.create(definition, { principalScope: 'user', agent: {} });
  await instance.prepare();
  const { runId } = await instance.start('input');
  const events = await collect(instance.events(runId));
  expect(events).toMatchObject([
    {
      type: 'error',
      error: {
        code: 'unavailable',
        message: 'The requested service is unavailable.',
        type: 'Error',
      },
    },
  ]);
  expect(JSON.stringify([instance.getSnapshot(), events])).not.toContain('secret');
  expect(diagnostics).toContainEqual(expect.objectContaining({ kind: 'run_failed', error: raw }));
  await runtime.dispose();
});

test('unknown executor error codes become a fixed executor failure and a protocol diagnostic', async () => {
  const raw = { code: 'executor-private-code' as ErrorCode, message: 'secret', type: 'TypeError' };
  const executor = new FakeExecutor([[{ type: 'error', error: raw }]]);
  const diagnostics: DiagnosticEvent[] = [];
  const runtime = createRuntime({
    appId: 'tests',
    executors: [executor],
    diagnostics: (event) => diagnostics.push(event),
  });
  const instance = await runtime.create(definition, { principalScope: 'user', agent: {} });
  await instance.prepare();
  const { runId } = await instance.start('input');
  const events = await collect(instance.events(runId));
  expect(events).toMatchObject([
    {
      type: 'error',
      error: {
        code: 'executor_error',
        message: 'The executor or agent code failed.',
        type: 'TypeError',
      },
    },
  ]);
  expect(instance.getSnapshot().run?.error?.code).toBe('executor_error');
  expect(JSON.stringify([instance.getSnapshot(), events])).not.toContain('secret');
  expect(diagnostics).toContainEqual(
    expect.objectContaining({ kind: 'protocol_violation', error: raw }),
  );
  await runtime.dispose();
});

test('an iterator that ends without an outcome fails with a protocol violation', async () => {
  const executor = new FakeExecutor([[]]);
  const diagnostics: DiagnosticEvent[] = [];
  const runtime = createRuntime({
    appId: 'tests',
    executors: [executor],
    diagnostics: (event) => diagnostics.push(event),
  });
  const instance = await runtime.create(definition, { principalScope: 'user', agent: {} });
  await instance.prepare();
  const { runId } = await instance.start('input');
  const events = await collect(instance.events(runId));
  expect(events).toMatchObject([
    { type: 'error', error: { code: 'executor_error', type: 'ProtocolViolation' } },
  ]);
  expect(instance.getSnapshot().run?.status).toBe('failed');
  expect(diagnostics).toContainEqual(
    expect.objectContaining({ kind: 'protocol_violation', runId }),
  );
  await runtime.dispose();
});

test('events after output are drained and dropped without a second terminal event', async () => {
  const executor = new FakeExecutor([
    [
      { type: 'output', output: 'done' },
      stream('late'),
      { type: 'error', error: { code: 'invalid', message: 'secret' } },
    ],
  ]);
  const diagnostics: DiagnosticEvent[] = [];
  const runtime = createRuntime({
    appId: 'tests',
    executors: [executor],
    diagnostics: (event) => diagnostics.push(event),
  });
  const instance = await runtime.create(definition, { principalScope: 'user', agent: {} });
  await instance.prepare();
  const { runId } = await instance.start('input');
  const events = await collect(instance.events(runId));
  await flush();
  expect(events).toMatchObject([{ type: 'output', sequence: 0 }]);
  expect(diagnostics.filter((event) => event.kind === 'late_event')).toHaveLength(2);
  expect(instance.getSnapshot().run?.status).toBe('succeeded');
  expect(executor.iteratorReturns).toBe(0);
  await runtime.dispose();
});

test('an interaction survives iterator completion and cancellation closes its events', async () => {
  const interaction: PendingInteraction = {
    interactionId: 'interaction' as InteractionId,
    surfaceId: 'main',
    viewRevision: 'revision' as ViewRevision,
    component: 'tests.Quiz/v1',
    props: { question: 'Continue?' },
  };
  const executor = new FakeExecutor([[{ type: 'interaction', interaction }]]);
  const diagnostics: DiagnosticEvent[] = [];
  const runtime = createRuntime({
    appId: 'tests',
    executors: [executor],
    diagnostics: (event) => diagnostics.push(event),
  });
  const instance = await runtime.create(definition, { principalScope: 'user', agent: {} });
  await instance.prepare();
  const { runId } = await instance.start('input');
  await flush();
  expect(instance.getSnapshot().run).toMatchObject({
    status: 'waiting_input',
    pending: interaction,
  });
  expect(diagnostics.some((event) => event.kind === 'protocol_violation')).toBe(false);
  const iterator = instance.events(runId)[Symbol.asyncIterator]();
  await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'interaction' } });
  let completed = false;
  const pending = iterator.next().then((result) => {
    completed = true;
    return result;
  });
  await flush();
  expect(completed).toBe(false);
  await expect(instance.start('other')).rejects.toMatchObject({ code: 'invalid' });
  await instance.cancel(runId);
  await expect(pending).resolves.toMatchObject({ value: { type: 'cancelled', sequence: 1 } });
  await expect(iterator.next()).resolves.toMatchObject({ done: true });
  await runtime.dispose();
});

test('an AbortError without an aborted run signal fails rather than cancels', async () => {
  const error = new Error('model failure');
  error.name = 'AbortError';
  const { instance, executor, runtime } = await ready([[{ throw: error }]]);
  await instance.start('input');
  await flush();
  expect(instance.getSnapshot().run).toMatchObject({
    status: 'failed',
    error: { code: 'executor_error', type: 'AbortError' },
  });
  expect(executor.requests[0]?.signal.aborted).toBe(false);
  await runtime.dispose();
});

test('cancel rejects stale IDs and returns the status already reached', async () => {
  const gate = deferred<void>();
  const { instance, executor, runtime } = await ready([[{ wait: gate.promise }, stream('late')]]);
  const { runId } = await instance.start('input');
  await flush();
  await expect(instance.cancel('other' as RunId)).rejects.toMatchObject({ code: 'stale' });
  await expect(instance.cancel(runId)).resolves.toEqual({ runId, status: 'cancelled' });
  expect(executor.requests[0]?.signal.aborted).toBe(true);
  await expect(instance.cancel(runId)).resolves.toEqual({ runId, status: 'cancelled' });
  gate.resolve();
  await flush();
  const events = await collect(instance.events(runId));
  expect(events).toMatchObject([{ type: 'cancelled', sequence: 0 }]);
  const next = await instance.start('next');
  await flush();
  await expect(instance.cancel(next.runId)).resolves.toEqual({
    runId: next.runId,
    status: 'succeeded',
  });
  expect(executor.iteratorReturns).toBe(0);
  await runtime.dispose();
});

test.each(['cancel', 'dispose'] as const)(
  '%s publishes the cancelled snapshot before synchronous abort callbacks',
  async (operation) => {
    const gate = deferred<void>();
    const { instance, executor, runtime } = await ready([[{ wait: gate.promise }]]);
    const { runId } = await instance.start('input');
    await flush();
    const observed: unknown[] = [];
    executor.requests[0]?.signal.addEventListener('abort', () => {
      observed.push(instance.getSnapshot());
    });
    const completion = operation === 'cancel' ? instance.cancel(runId) : instance.dispose();
    expect(observed).toMatchObject([
      {
        state: operation === 'cancel' ? 'ready' : 'disposing',
        run: { runId, status: 'cancelled' },
      },
    ]);
    gate.resolve();
    await completion;
    await runtime.dispose();
  },
);

test('a cancelled predecessor must settle before the next run enters the executor', async () => {
  vi.useFakeTimers();
  const { instance, executor, runtime } = await ready([
    (request) => {
      const gate = new Promise<void>((resolve) => {
        request.signal.addEventListener(
          'abort',
          () => {
            setTimeout(resolve, 50);
          },
          { once: true },
        );
      });
      return {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            await gate;
            return { done: true, value: undefined };
          },
        }),
      };
    },
    [{ type: 'output', output: 'next' }],
  ]);
  const first = await instance.start('first');
  await flush();
  await instance.cancel(first.runId);
  expect(instance.getSnapshot().run?.status).toBe('cancelled');
  const second = await instance.start('second');
  expect(instance.getSnapshot().run).toMatchObject({ runId: second.runId, status: 'queued' });
  await vi.advanceTimersByTimeAsync(49);
  expect(executor.requests).toHaveLength(1);
  expect(instance.getSnapshot().run?.status).toBe('queued');
  await vi.advanceTimersByTimeAsync(1);
  expect(executor.requests).toHaveLength(2);
  expect(instance.getSnapshot().run?.status).toBe('succeeded');
  expect(executor.requests[0]?.sessionId).toBe(executor.requests[1]?.sessionId);
  await runtime.dispose();
});

test('output does not release the settlement barrier before iterator completion', async () => {
  const gate = deferred<void>();
  const { instance, executor, runtime } = await ready([
    [{ type: 'output', output: 'done' }, { wait: gate.promise }],
  ]);
  await instance.start('first');
  await flush();
  expect(instance.getSnapshot().run?.status).toBe('succeeded');
  await instance.start('second');
  await flush();
  expect(instance.getSnapshot().run?.status).toBe('queued');
  expect(executor.requests).toHaveLength(1);
  gate.resolve();
  await flush();
  expect(executor.requests).toHaveLength(2);
  expect(executor.iteratorReturns).toBe(0);
  await runtime.dispose();
});

test('queued timeouts never remove an unsettled predecessor from the barrier', async () => {
  vi.useFakeTimers();
  const gate = deferred<void>();
  const { instance, executor, runtime } = await ready([[{ wait: gate.promise }]]);
  const first = await instance.start('first');
  await flush();
  await instance.cancel(first.runId);
  await instance.start('second');
  await vi.advanceTimersByTimeAsync(9_999);
  expect(instance.getSnapshot().run?.status).toBe('queued');
  await vi.advanceTimersByTimeAsync(1);
  expect(instance.getSnapshot().run).toMatchObject({
    status: 'failed',
    error: { code: 'timeout' },
  });
  await instance.start('third');
  await vi.advanceTimersByTimeAsync(10_000);
  expect(instance.getSnapshot().run).toMatchObject({
    status: 'failed',
    error: { code: 'timeout' },
  });
  expect(executor.requests).toHaveLength(1);
  gate.resolve();
  await flush();
  await runtime.dispose();
});

test('dispose cancels immediately and disposes the executor only after settlement', async () => {
  const gate = deferred<void>();
  const { instance, executor } = await ready([[{ wait: gate.promise }, stream('late')]]);
  const { runId } = await instance.start('input');
  await flush();
  const disposal = instance.dispose();
  expect(instance.getSnapshot()).toMatchObject({
    state: 'disposing',
    run: { status: 'cancelled' },
  });
  expect(executor.requests[0]?.signal.aborted).toBe(true);
  await flush();
  expect(executor.disposeCalls).toBe(0);
  gate.resolve();
  await disposal;
  expect(instance.getSnapshot().state).toBe('disposed');
  expect(executor.disposeCalls).toBe(1);
  expect(executor.iteratorReturns).toBe(0);
  await expect(instance.cancel(runId)).rejects.toMatchObject({ code: 'invalid' });
});

test('dispose bounds its wait for a nonsettling executor at ten seconds', async () => {
  vi.useFakeTimers();
  const gate = deferred<void>();
  const { instance, executor } = await ready([[{ wait: gate.promise }]]);
  await instance.start('input');
  await flush();
  const disposal = instance.dispose();
  await vi.advanceTimersByTimeAsync(9_999);
  expect(instance.getSnapshot().state).toBe('disposing');
  expect(executor.disposeCalls).toBe(0);
  await vi.advanceTimersByTimeAsync(1);
  await disposal;
  expect(instance.getSnapshot().state).toBe('disposed');
  expect(executor.disposeCalls).toBe(1);
  gate.resolve();
  await flush();
  expect(executor.iteratorReturns).toBe(0);
});

test('a failing executor dispose reports raw diagnostics and still ends disposed', async () => {
  const raw = new Error('secret');
  const executor = new FakeExecutor();
  executor.disposeError = raw;
  const diagnostics: DiagnosticEvent[] = [];
  const runtime = createRuntime({
    appId: 'tests',
    executors: [executor],
    diagnostics: (event) => diagnostics.push(event),
  });
  const instance = await runtime.create(definition, { principalScope: 'user', agent: {} });
  await instance.prepare();
  await instance.dispose();
  expect(instance.getSnapshot().state).toBe('disposed');
  expect(JSON.stringify(instance.getSnapshot())).not.toContain('secret');
  expect(diagnostics).toContainEqual(
    expect.objectContaining({ kind: 'executor_dispose_failed', error: raw }),
  );
});

test('a queued listener can cancel without starting an executor or duplicating terminal events', async () => {
  const { instance, executor, runtime } = await ready();
  instance.subscribe(() => {
    const run = instance.getSnapshot().run;
    if (run?.status === 'queued') void instance.cancel(run.runId);
  });
  const { runId } = await instance.start('input');
  await flush();
  expect(instance.getSnapshot().run?.status).toBe('cancelled');
  expect(executor.requests).toHaveLength(0);
  expect(await collect(instance.events(runId))).toMatchObject([{ type: 'cancelled', sequence: 0 }]);
  await runtime.dispose();
});
