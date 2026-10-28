// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, expect, expectTypeOf, test, vi } from 'vitest';
import {
  type AgentInstance,
  createRuntime,
  type ExecutorAdapter,
  type ExecutorAgent,
} from '../src/index.js';
import { definition, FakeExecutor, flush } from './fake-executor.js';

afterEach(() => vi.unstubAllGlobals());

test('runtime creation rejects an empty application ID synchronously', () => {
  expect(() => createRuntime({ appId: '', executors: [] })).toThrow(
    expect.objectContaining({ code: 'invalid' }),
  );
});

test('executor IDs must be unique', () => {
  expect(() =>
    createRuntime({ appId: 'tests', executors: [new FakeExecutor(), new FakeExecutor()] }),
  ).toThrow(expect.objectContaining({ code: 'invalid' }));
});

test('runtime creation requires crypto.randomUUID', () => {
  vi.stubGlobal('crypto', { randomUUID: undefined });
  expect(() => createRuntime({ appId: 'tests', executors: [] })).toThrow(
    expect.objectContaining({ code: 'unsupported' }),
  );
});

test('create rejects an unregistered executor', async () => {
  const runtime = createRuntime({ appId: 'tests', executors: [] });
  await expect(
    runtime.create(definition, { principalScope: 'user', agent: undefined }),
  ).rejects.toMatchObject({
    code: 'unsupported',
  });
  await runtime.dispose();
});

test('each instance has a fresh identity and session', async () => {
  const executor = new FakeExecutor();
  const runtime = createRuntime({ appId: 'tests', executors: [executor] });
  const first = await runtime.create(definition, { principalScope: 'user', agent: {} });
  const second = await runtime.create(definition, { principalScope: 'user', agent: {} });
  expect(first.getSnapshot().state).toBe('created');
  expect(first.instanceId).not.toBe(second.instanceId);
  await Promise.all([first.prepare(), second.prepare()]);
  await Promise.all([first.start('first'), second.start('second')]);
  await flush();
  expect(executor.requests).toHaveLength(2);
  expect(executor.requests[0]?.sessionId).not.toBe(executor.requests[1]?.sessionId);
  await runtime.dispose();
});

test('typed adapters and input schemas retain their public types', async () => {
  const prepared = new FakeExecutor();
  const received: unknown[] = [];
  const typed = {
    id: 'typed' as const,
    version: '1.0.0',
    features: prepared.features,
    async prepare(
      agent: { readonly graph: string },
      services: { readonly model: string },
    ): Promise<ExecutorAgent> {
      received.push(agent, services);
      return prepared.agent;
    },
  } satisfies ExecutorAdapter<{ readonly graph: string }, { readonly model: string }>;
  const runtime = createRuntime({ appId: 'tests', executors: [typed] });
  const instance = await runtime.create(
    { ...definition, executor: 'typed' },
    {
      principalScope: 'user',
      agent: { graph: 'graph' },
      services: { model: 'model' },
    },
  );
  expectTypeOf(instance).toEqualTypeOf<AgentInstance<string, unknown>>();
  await instance.prepare();
  expect(received).toEqual([{ graph: 'graph' }, { model: 'model' }]);
  await runtime.dispose();
});

test('runtime disposal disposes every instance and returns the same promise', async () => {
  const executor = new FakeExecutor();
  const runtime = createRuntime({ appId: 'tests', executors: [executor] });
  const first = await runtime.create(definition, { principalScope: 'user', agent: {} });
  const second = await runtime.create(definition, { principalScope: 'user', agent: {} });
  await Promise.all([first.prepare(), second.prepare()]);
  const disposal = runtime.dispose();
  expect(runtime.dispose()).toBe(disposal);
  await disposal;
  expect(first.getSnapshot().state).toBe('disposed');
  expect(second.getSnapshot().state).toBe('disposed');
  expect(executor.disposeCalls).toBe(2);
  await expect(
    runtime.create(definition, { principalScope: 'user', agent: {} }),
  ).rejects.toMatchObject({ code: 'invalid' });
});
