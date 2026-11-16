// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it('installs one policy, adds only same-origin worker URLs, and rejects every other URL', async () => {
  vi.stubGlobal('location', new URL('https://example.test/app/'));
  let scriptURL: ((value: string) => string) | undefined;
  const createPolicy = vi.fn((_name: string, rules: { createScriptURL(value: string): string }) => {
    scriptURL = rules.createScriptURL;
  });
  vi.stubGlobal('trustedTypes', { createPolicy });
  const Worker = vi.fn(class WorkerMock {});
  vi.stubGlobal('Worker', Worker);
  const { installWorkerPolicy, createWorker } = await import('../src/worker-policy.js');
  installWorkerPolicy('/assets/go.js');
  installWorkerPolicy('/assets/go.js');
  expect(createPolicy).toHaveBeenCalledOnce();
  expect(createPolicy.mock.calls[0]?.[0]).toBe('default');
  expect(scriptURL?.('/assets/go.js')).toBe('https://example.test/assets/go.js');
  expect(() => scriptURL?.('/assets/other.js')).toThrow('The worker script URL is not allowed.');
  expect(() => scriptURL?.('https://elsewhere.test/assets/go.js')).toThrow();
  expect(() => installWorkerPolicy('https://elsewhere.test/assets/go.js')).toThrow();
  createWorker('/assets/webllm.js');
  expect(createPolicy).toHaveBeenCalledOnce();
  expect(scriptURL?.('/assets/webllm.js')).toBe('https://example.test/assets/webllm.js');
  expect(Worker).toHaveBeenCalledWith(new URL('https://example.test/assets/webllm.js'), {
    type: 'module',
  });
});
