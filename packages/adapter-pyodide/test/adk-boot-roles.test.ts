// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test, vi } from 'vitest';
import { createPyodideAdapter, type PyodideWorkerPort } from '../src/adapter.js';
import { type BootPayload, encodeBridge, parseBridge, success } from '../src/bridge.js';

const boot = {
  framework: 'adk',
  runtimeUrl: 'https://example.test/python/',
  wheelsUrl: 'https://example.test/wheels/',
  localWheels: [],
  sources: [{ path: 'agent.py', text: 'def create_agent(): pass' }],
  module: 'agent',
  entry: 'create_agent',
};
const parse = (payload: unknown): ReturnType<typeof parseBridge> =>
  parseBridge(
    JSON.stringify({
      v: 'galaxie.bridge/v2',
      kind: 'request',
      id: 'one',
      op: 'boot',
      payload,
    }),
  );

test('ADK boot carries only bounded string roles and keeps the optional field absent for old callers', () => {
  expect(parse(boot)).toMatchObject({ payload: boot });
  expect(parse({ ...boot, roles: ['answer'] })).toMatchObject({ payload: { roles: ['answer'] } });
  for (const roles of [null, 'answer', {}, [1], [''], ['x'.repeat(129)], Array(257).fill('x')])
    expect(() => parse({ ...boot, roles })).toThrow('The request is invalid.');
  for (const framework of [undefined, 'langgraph', 'dspy', 'pydantic-ai'])
    expect(() => parse({ ...boot, framework, roles: ['answer'] })).toThrow(
      'The request is invalid.',
    );
});

class BootWorker implements PyodideWorkerPort {
  readonly listeners = new Set<(event: { readonly data: unknown }) => void>();
  payload: BootPayload | undefined;
  postMessage(raw: string): void {
    const request = parseBridge(raw);
    if (request.kind !== 'request' || request.op !== 'boot') return;
    this.payload = request.payload as BootPayload;
    queueMicrotask(() => {
      for (const listener of this.listeners)
        listener({ data: encodeBridge(success(request, { coldStartMs: 1 })) });
    });
  }
  addEventListener(
    type: 'message' | 'error',
    listener: (event: { readonly data: unknown }) => void,
  ): void {
    if (type === 'message') this.listeners.add(listener);
  }
  removeEventListener(
    type: 'message' | 'error',
    listener: (event: { readonly data: unknown }) => void,
  ): void {
    if (type === 'message') this.listeners.delete(listener);
  }
  terminate(): void {}
}

test('the host omits out-of-bound roles, caps valid roles and sends the inventory only to ADK', async () => {
  const origin = typeof location === 'undefined' ? 'http://127.0.0.1:1234' : location.origin;
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => new Response('def create_agent(): pass'));
  const roles = Array.from({ length: 300 }, (_, index) => `role${index}`);
  try {
    for (const framework of ['adk', 'langgraph', 'dspy', 'pydantic-ai'] as const) {
      const worker = new BootWorker();
      const prepared = await createPyodideAdapter({
        framework,
        createWorker: () => worker,
        runtimeUrl: `${origin}/python/`,
        wheelsUrl: `${origin}/wheels/`,
        localWheels: [],
      }).prepare(
        {
          baseUrl: `${origin}/agent/`,
          files: ['agent.py'],
          module: 'agent',
          entry: 'create_agent',
        },
        { chatModels: {} },
        {
          signal: new AbortController().signal,
          models: { roles: ['', 'x'.repeat(129), ...roles], providers: {} },
        },
      );
      try {
        expect(worker.payload?.roles).toEqual(
          framework === 'adk' ? roles.slice(0, 256) : undefined,
        );
      } finally {
        await prepared.dispose();
      }
    }
  } finally {
    fetch.mockRestore();
  }
});
