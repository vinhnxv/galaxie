// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, expect, test, vi } from 'vitest';
import {
  createRuntime,
  type DiagnosticEvent,
  type ExecutorAgent,
  GalaxieError,
  type InteractionId,
  type RunId,
  type UserInteractionEvent,
  type ViewRevision,
} from '../src/index.js';
import { deferred, definition, FakeExecutor, flush, ready } from './fake-executor.js';

afterEach(() => vi.unstubAllGlobals());

test('preparing callers share exactly one promise and one adapter call', async () => {
  const executor = new FakeExecutor();
  const gate = deferred<ExecutorAgent>();
  executor.prepares.push(() => gate.promise);
  const runtime = createRuntime({ appId: 'tests', executors: [executor] });
  const instance = await runtime.create(definition, { principalScope: 'user', agent: {} });
  const preparation = instance.prepare();
  expect(instance.prepare()).toBe(preparation);
  expect(instance.getSnapshot().state).toBe('preparing');
  await flush();
  expect(executor.prepareCalls).toBe(1);
  gate.resolve(executor.agent);
  await preparation;
  expect(instance.getSnapshot().state).toBe('ready');
  await instance.prepare();
  expect(executor.prepareCalls).toBe(1);
  await runtime.dispose();
});

test('a failed prepare returns to created and retry clears the stored error', async () => {
  const executor = new FakeExecutor();
  const raw = new TypeError('secret');
  executor.prepares.push(async () => {
    throw raw;
  });
  const diagnostics: DiagnosticEvent[] = [];
  const runtime = createRuntime({
    appId: 'tests',
    executors: [executor],
    diagnostics: (event) => diagnostics.push(event),
  });
  const instance = await runtime.create(definition, { principalScope: 'user', agent: {} });
  await expect(instance.prepare()).rejects.toMatchObject({ code: 'executor_error' });
  expect(instance.getSnapshot()).toMatchObject({
    state: 'created',
    prepareError: { code: 'executor_error', type: 'TypeError' },
  });
  expect(JSON.stringify(instance.getSnapshot())).not.toContain('secret');
  expect(diagnostics).toContainEqual(
    expect.objectContaining({ kind: 'prepare_failed', error: raw }),
  );
  const retry = instance.prepare();
  expect(instance.getSnapshot().prepareError).toBeUndefined();
  await retry;
  expect(instance.getSnapshot().state).toBe('ready');
  expect(executor.prepareCalls).toBe(2);
  await runtime.dispose();
});

test('prepare preserves a documented code without exposing executor error text', async () => {
  const executor = new FakeExecutor();
  executor.prepares.push(async () => {
    throw new GalaxieError('invalid', 'secret');
  });
  const runtime = createRuntime({ appId: 'tests', executors: [executor] });
  const instance = await runtime.create(definition, { principalScope: 'user', agent: {} });
  await expect(instance.prepare()).rejects.toMatchObject({
    code: 'invalid',
    message: 'The request is invalid.',
  });
  expect(instance.getSnapshot().prepareError?.message).toBe('The request is invalid.');
  await runtime.dispose();
});

test('disposing a pending prepare aborts it and disposes a late agent once', async () => {
  const executor = new FakeExecutor();
  const gate = deferred<ExecutorAgent>();
  executor.prepares.push(() => gate.promise);
  const runtime = createRuntime({ appId: 'tests', executors: [executor] });
  const instance = await runtime.create(definition, { principalScope: 'user', agent: {} });
  const preparation = instance.prepare();
  const rejected = expect(preparation).rejects.toMatchObject({ code: 'cancelled' });
  await flush();
  const disposal = instance.dispose();
  expect(instance.dispose()).toBe(disposal);
  expect(executor.prepareSignals[0]?.aborted).toBe(true);
  await rejected;
  await disposal;
  expect(instance.getSnapshot().state).toBe('disposed');
  gate.resolve(executor.agent);
  await flush();
  expect(executor.disposeCalls).toBe(1);
  await runtime.dispose();
  expect(executor.disposeCalls).toBe(1);
});

test('snapshots are stable between changes and frozen after each change', async () => {
  const executor = new FakeExecutor();
  const runtime = createRuntime({ appId: 'tests', executors: [executor] });
  const instance = await runtime.create(definition, { principalScope: 'user', agent: {} });
  const created = instance.getSnapshot();
  expect(instance.getSnapshot()).toBe(created);
  expect(Object.isFrozen(created)).toBe(true);
  const preparing = instance.prepare();
  const changed = instance.getSnapshot();
  expect(changed).not.toBe(created);
  expect(changed.state).toBe('preparing');
  await preparing;
  await instance.start('input');
  await flush();
  const succeeded = instance.getSnapshot();
  expect(Object.isFrozen(succeeded)).toBe(true);
  expect(Object.isFrozen(succeeded.run)).toBe(true);
  expect(instance.getSnapshot()).toBe(succeeded);
  await runtime.dispose();
});

test('listeners run synchronously and a throwing listener does not stop the others', async () => {
  const microtasks: Array<() => void> = [];
  vi.stubGlobal('queueMicrotask', (callback: () => void) => {
    microtasks.push(callback);
  });
  const raw = new Error('listener failed');
  const diagnostics: DiagnosticEvent[] = [];
  const runtime = createRuntime({
    appId: 'tests',
    executors: [new FakeExecutor()],
    diagnostics: (event) => diagnostics.push(event),
  });
  const instance = await runtime.create(definition, { principalScope: 'user', agent: {} });
  const calls: string[] = [];
  instance.subscribe(() => calls.push(`first:${instance.getSnapshot().state}`));
  const detach = instance.subscribe(() => {
    calls.push('second');
    throw raw;
  });
  instance.subscribe(() => calls.push('third'));
  const preparation = instance.prepare();
  expect(calls).toEqual(['first:preparing', 'second', 'third']);
  expect(diagnostics).toContainEqual(
    expect.objectContaining({ kind: 'listener_threw', error: raw }),
  );
  expect(() => microtasks[0]?.()).toThrow(raw);
  detach();
  await preparation;
  await runtime.dispose();
});

test('a reentrant preparing listener receives the already installed shared promise', async () => {
  const executor = new FakeExecutor();
  const runtime = createRuntime({ appId: 'tests', executors: [executor] });
  const instance = await runtime.create(definition, { principalScope: 'user', agent: {} });
  let nested: Promise<void> | undefined;
  instance.subscribe(() => {
    if (instance.getSnapshot().state === 'preparing') nested = instance.prepare();
  });
  const preparation = instance.prepare();
  expect(nested).toBe(preparation);
  await preparation;
  await runtime.dispose();
});

test('a failure listener may retry prepare without changing the first rejection', async () => {
  const executor = new FakeExecutor();
  executor.prepares.push(async () => {
    throw new TypeError('secret');
  });
  const runtime = createRuntime({ appId: 'tests', executors: [executor] });
  const instance = await runtime.create(definition, { principalScope: 'user', agent: {} });
  let retry: Promise<void> | undefined;
  instance.subscribe(() => {
    const snapshot = instance.getSnapshot();
    if (snapshot.state === 'created' && snapshot.prepareError !== undefined) {
      retry = instance.prepare();
    }
  });
  await expect(instance.prepare()).rejects.toMatchObject({ code: 'executor_error' });
  await retry;
  expect(instance.getSnapshot().state).toBe('ready');
  expect(executor.prepareCalls).toBe(2);
  await runtime.dispose();
});

test('dispose from a preparing listener cannot resurrect the instance', async () => {
  const executor = new FakeExecutor();
  const runtime = createRuntime({ appId: 'tests', executors: [executor] });
  const instance = await runtime.create(definition, { principalScope: 'user', agent: {} });
  instance.subscribe(() => {
    if (instance.getSnapshot().state === 'preparing') void instance.dispose();
  });
  await expect(instance.prepare()).rejects.toMatchObject({ code: 'cancelled' });
  await instance.dispose();
  await flush();
  expect(instance.getSnapshot().state).toBe('disposed');
  expect(executor.disposeCalls).toBe(1);
  expect(executor.prepareSignals[0]?.aborted).toBe(true);
});

test('disposed instances reject operations and never notify listeners again', async () => {
  const { instance, executor } = await ready();
  const { runId } = await instance.start('input');
  await flush();
  let calls = 0;
  instance.subscribe(() => {
    calls++;
  });
  const disposal = instance.dispose();
  await expect(instance.start('input')).rejects.toMatchObject({ code: 'invalid' });
  await expect(instance.prepare()).rejects.toMatchObject({ code: 'invalid' });
  await expect(instance.cancel(runId)).rejects.toMatchObject({ code: 'invalid' });
  await expect(instance.events(runId)[Symbol.asyncIterator]().next()).rejects.toMatchObject({
    code: 'invalid',
  });
  await disposal;
  const before = calls;
  instance.subscribe(() => {
    calls++;
  });
  await instance.dispose();
  await expect(instance.dispatch({} as UserInteractionEvent)).rejects.toMatchObject({
    code: 'invalid',
  });
  expect(calls).toBe(before);
  expect(executor.disposeCalls).toBe(1);
});

test('dispatch rejects unsupported in this slice', async () => {
  const { instance, runtime } = await ready();
  await expect(
    instance.dispatch({
      instanceId: instance.instanceId,
      runId: 'run' as RunId,
      interactionId: 'interaction' as InteractionId,
      surfaceId: 'main',
      viewRevision: 'revision' as ViewRevision,
      action: 'submit',
      payload: {},
    }),
  ).rejects.toMatchObject({ code: 'unsupported' });
  await runtime.dispose();
});
