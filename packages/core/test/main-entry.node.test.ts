// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, expect, onTestFinished, test } from 'vitest';

beforeEach(() => {
  const names = [
    'navigator',
    'document',
    'window',
    'BroadcastChannel',
    'localStorage',
    'sessionStorage',
  ] as const;
  const descriptors = names.map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  onTestFinished(() => {
    for (const [name, descriptor] of descriptors) {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
      else Object.defineProperty(globalThis, name, descriptor);
    }
  });
  for (const name of names) {
    expect(Reflect.deleteProperty(globalThis, name)).toBe(true);
    expect(name in globalThis).toBe(false);
  }
});

test('the main entry imports and completes a run without browser globals', async () => {
  const core = await import('../src/index.js');
  expect(core).not.toHaveProperty('acquireOwnership');
  expect(core).not.toHaveProperty('watchInvalidation');
  const { collect, definition, FakeExecutor } = await import('./fake-executor.js');
  const executor = new FakeExecutor();
  const runtime = core.createRuntime({
    appId: 'node-entry',
    executors: [executor],
    developmentWarnings: () => {},
  });
  onTestFinished(() => runtime.dispose());
  const instance = await runtime.create(definition, { principalScope: 'user', agent: {} });
  await instance.prepare();
  const { runId } = await instance.start('input');
  const events = await collect(instance.events(runId));
  expect(executor.requests).toHaveLength(1);
  expect(events).toContainEqual(expect.objectContaining({ type: 'output', output: 'done' }));
  expect(instance.getSnapshot().run?.status).toBe('succeeded');
});

test('the browser entry keeps its exports and missing-channel error', async () => {
  const browser = await import('../src/browser.js');
  expect(browser.acquireOwnership).toBeTypeOf('function');
  expect(browser.watchInvalidation).toBeTypeOf('function');
  const options = { appId: 'node-entry', principalScope: 'user' };
  expect(() => browser.watchInvalidation(options)).toThrowError(
    expect.objectContaining({ code: 'unsupported', message: 'This operation is unsupported.' }),
  );
});
