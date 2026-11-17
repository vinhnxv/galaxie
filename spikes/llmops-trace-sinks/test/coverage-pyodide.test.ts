// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, test, vi } from 'vitest';
import { runPyodide } from '../src/families/pyodide.js';

const state = vi.hoisted(() => ({
  server: undefined as import('node:http').Server | undefined,
  prepared: false,
  terminated: false,
  disposed: false,
}));

vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  existsSync: () => true,
}));
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  readFile: async (path: unknown) =>
    String(path).endsWith('local-wheels.json') ? JSON.stringify({ packages: [] }) : Buffer.alloc(0),
}));
vi.mock('node:http', async (original) => {
  const http = await original<typeof import('node:http')>();
  return {
    ...http,
    createServer: (...args: Parameters<typeof http.createServer>) => {
      state.server = http.createServer(...args);
      return state.server;
    },
  };
});
vi.mock('node:worker_threads', () => ({
  Worker: class {
    on(): this {
      return this;
    }
    async terminate(): Promise<number> {
      state.terminated = true;
      return 0;
    }
  },
}));
vi.mock('@galaxie-ai/adapter-pyodide', async (original) => ({
  ...(await original<typeof import('@galaxie-ai/adapter-pyodide')>()),
  createPyodideAdapter: (options: unknown) => ({ options }),
}));
vi.mock('@galaxie-ai/core', async (original) => ({
  ...(await original<typeof import('@galaxie-ai/core')>()),
  createRuntime: (options: { executors: Array<{ options: { createWorker(): unknown } }> }) => ({
    async create() {
      options.executors[0]?.options.createWorker();
      return {
        prepare: () => {
          state.prepared = true;
          return new Promise<never>(() => {});
        },
      };
    },
    async dispose() {
      state.disposed = true;
    },
  }),
}));

afterEach(() => {
  vi.useRealTimers();
  state.server?.closeAllConnections();
  state.server?.close();
});

test('the Python runner tears down its worker and server when prepare hangs', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const pending = runPyodide();
  const rejected = expect(pending).rejects.toThrow('Python coverage timed out after 180000ms');
  await vi.waitFor(() => expect(state.prepared).toBe(true));
  expect(state.server?.listening).toBe(true);
  await vi.advanceTimersByTimeAsync(180_000);
  await rejected;
  expect(state.terminated).toBe(true);
  expect(state.server?.listening).toBe(false);
  expect(state.disposed).toBe(true);
}, 1000);
