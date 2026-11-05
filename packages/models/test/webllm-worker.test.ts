// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test, vi } from 'vitest';

const mocked = vi.hoisted(() => ({
  handlers: [] as {
    onmessage: ReturnType<typeof vi.fn>;
    postMessage: (message: unknown) => void;
  }[],
}));
vi.mock('@mlc-ai/web-llm', () => ({
  WebWorkerMLCEngineHandler: class {
    onmessage = vi.fn();
    postMessage(_message: unknown): void {}
    constructor() {
      mocked.handlers.push(this);
    }
  },
}));

test('worker entry import is inert, starts once, and forwards only through its scope', async () => {
  const { startWebLLMWorker } = await import('../src/webllm/worker.js');
  expect(mocked.handlers).toHaveLength(0);
  const postMessage = vi.fn();
  const addEventListener = vi.fn();
  const scope = { postMessage, addEventListener };
  startWebLLMWorker(scope);
  expect(mocked.handlers).toHaveLength(1);
  expect(addEventListener).toHaveBeenCalledTimes(1);
  expect(addEventListener.mock.calls[0]?.[0]).toBe('message');
  const event = { data: { kind: 'request' } };
  addEventListener.mock.calls[0]?.[1](event);
  expect(mocked.handlers[0]?.onmessage).toHaveBeenCalledExactlyOnceWith(event);
  mocked.handlers[0]?.postMessage({ kind: 'reply' });
  expect(postMessage).toHaveBeenCalledExactlyOnceWith({ kind: 'reply' });
  expect(() => startWebLLMWorker(scope)).toThrow('The WebLLM worker is already started.');
  expect(mocked.handlers).toHaveLength(1);
});

test('worker entry refuses a window before installing listeners', async () => {
  const { startWebLLMWorker } = await import('../src/webllm/worker.js');
  const scope = { document: {}, postMessage: vi.fn(), addEventListener: vi.fn() };
  expect(() => startWebLLMWorker(scope)).toThrow('The WebLLM worker requires a worker scope.');
  expect(scope.addEventListener).not.toHaveBeenCalled();
});
