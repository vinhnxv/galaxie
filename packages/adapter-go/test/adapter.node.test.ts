// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test, vi } from 'vitest';
import { createGoAdapter, GO_EXECUTOR_ID, type GoAgent, type GoWorkerPort } from '../src/index.js';
import { encodeWorkerMessage, type WorkerMessage } from '../src/protocol.js';

const agent: GoAgent = {
  wasm: { url: 'http://127.0.0.1/go/agent.wasm', sha256: 'a'.repeat(64), bytes: 1024 },
  entry: 'reference',
};

class FakeWorker implements GoWorkerPort {
  readonly sent: unknown[] = [];
  terminated = false;
  readonly #messages = new Set<(event: { readonly data: unknown }) => void>();
  readonly #errors = new Set<() => void>();
  readonly #reply: WorkerMessage | undefined;
  /** The reply to a boot message; undefined keeps the Worker silent. */
  constructor(reply?: WorkerMessage) {
    this.#reply = reply;
  }
  postMessage(message: string): void {
    this.sent.push(JSON.parse(message));
    const reply = this.#reply;
    if (reply) queueMicrotask(() => this.emit(reply));
  }
  emit(message: WorkerMessage): void {
    for (const listener of this.#messages) listener({ data: encodeWorkerMessage(message) });
  }
  fail(): void {
    for (const listener of this.#errors) listener();
  }
  addEventListener(type: 'message' | 'error', listener: never): void {
    if (type === 'message') this.#messages.add(listener);
    else this.#errors.add(listener);
  }
  removeEventListener(type: 'message' | 'error', listener: never): void {
    if (type === 'message') this.#messages.delete(listener);
    else this.#errors.delete(listener);
  }
  terminate(): void {
    this.terminated = true;
  }
}

const ready: WorkerMessage = { v: 1, kind: 'ready', coldStartMs: 12 };
const options = (worker: () => GoWorkerPort, readyTimeoutMs?: number) => ({
  createWorker: worker,
  ...(readyTimeoutMs === undefined ? {} : { readyTimeoutMs }),
});
const services = { chatModels: {} };
const prepare = (adapter: ReturnType<typeof createGoAdapter>, value: unknown = agent) =>
  adapter.prepare(value as GoAgent, services, { signal: new AbortController().signal });
const runRequest = (command: unknown = { type: 'start', input: { prompt: 'x' } }): never =>
  ({ signal: new AbortController().signal, sessionId: 's', command }) as never;
const firstEvent = async (
  prepared: { run(request: never): AsyncIterable<unknown> },
  command?: unknown,
) => (await prepared.run(runRequest(command))[Symbol.asyncIterator]().next()).value;

test('the adapter registers adk-go with only streaming on', () => {
  const adapter = createGoAdapter(options(() => new FakeWorker(ready)));
  expect(adapter.id).toBe('adk-go');
  expect(GO_EXECUTOR_ID).toBe('adk-go');
  expect(adapter.features).toEqual({
    interrupts: false,
    resume: false,
    checkpoints: false,
    streaming: true,
    subgraphs: false,
  });
});

test('prepare boots a Worker with the reviewed module and a resume fails unsupported', async () => {
  const worker = new FakeWorker(ready);
  const onBoot = vi.fn();
  const adapter = createGoAdapter({ ...options(() => worker), onBoot });
  const prepared = await prepare(adapter);
  expect(worker.sent).toEqual([{ v: 1, kind: 'boot', wasm: agent.wasm }]);
  expect(onBoot.mock.calls.map(([event]) => event)).toEqual([
    { phase: 'booting' },
    { phase: 'ready', coldStartMs: 12 },
  ]);
  expect(await firstEvent(prepared, { type: 'resume', interactionId: 'i' })).toMatchObject({
    type: 'error',
    error: { code: 'unsupported' },
  });
  await expect(prepared.pending('s' as never)).resolves.toBeUndefined();
  await prepared.dispose();
  expect(worker.terminated).toBe(true);
});

test.each([
  ['a missing digest', { ...agent, wasm: { ...agent.wasm, sha256: 'xyz' } }],
  ['an oversized module', { ...agent, wasm: { ...agent.wasm, bytes: 65 * 1024 * 1024 } }],
  ['a relative module URL', { ...agent, wasm: { ...agent.wasm, url: '/go/agent.wasm' } }],
  ['a URL with credentials', { wasm: { ...agent.wasm, url: 'http://user:pw@127.0.0.1/a.wasm' } }],
  ['an extra field', { ...agent, extra: true }],
  ['a non-boolean stream flag', { ...agent, stream: 'yes' }],
  ['a numeric stream flag', { ...agent, stream: 1 }],
  ['an undefined stream key', { ...agent, stream: undefined }],
  ['no agent', null],
])('%s fails invalid before a Worker exists', async (_name, value) => {
  const createWorker = vi.fn(() => new FakeWorker(ready));
  await expect(prepare(createGoAdapter({ createWorker }), value)).rejects.toMatchObject({
    code: 'invalid',
  });
  expect(createWorker).not.toHaveBeenCalled();
});

test.each([
  ['no services', undefined],
  ['services without models', {}],
  ['a model that cannot invoke', { chatModels: { a: 1 } }],
])('%s fail invalid before a Worker exists', async (_name, value) => {
  const createWorker = vi.fn(() => new FakeWorker(ready));
  await expect(
    createGoAdapter({ createWorker }).prepare(agent, value as never, {
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: 'invalid' });
  expect(createWorker).not.toHaveBeenCalled();
});

test('a build that differs from the expected build fails unavailable and is terminated', async () => {
  const module = { version: 'v1', sum: 'h1:a' };
  const expected = { go: 'go1.27.3', adk: module, genai: module };
  for (const reported of [
    undefined,
    { ...expected, go: 'go1.0' },
    { ...expected, adk: { ...module, sum: 'h1:b' } },
  ]) {
    const worker = new FakeWorker({
      v: 1,
      kind: 'ready',
      coldStartMs: 1,
      ...(reported ? { build: reported } : {}),
    });
    await expect(
      prepare(createGoAdapter({ ...options(() => worker), expectedBuild: expected })),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(worker.terminated).toBe(true);
  }
  const matching = new FakeWorker({ v: 1, kind: 'ready', coldStartMs: 1, build: expected });
  const prepared = await prepare(
    createGoAdapter({ ...options(() => matching), expectedBuild: expected }),
  );
  await prepared.dispose();
});

test('a Worker that never signals ready times out and is terminated', async () => {
  const worker = new FakeWorker();
  const adapter = createGoAdapter(options(() => worker, 20));
  await expect(prepare(adapter)).rejects.toMatchObject({ code: 'unavailable' });
  expect(worker.terminated).toBe(true);
});

test.each([
  ['reports failure', new FakeWorker({ v: 1, kind: 'failed' })],
  ['exits during boot', new FakeWorker({ v: 1, kind: 'exit', code: 2 })],
])('a Worker that %s fails unavailable and is terminated', async (_name, worker) => {
  await expect(prepare(createGoAdapter(options(() => worker)))).rejects.toMatchObject({
    code: 'unavailable',
  });
  expect(worker.terminated).toBe(true);
});

test('an aborted prepare terminates the Worker and fails cancelled', async () => {
  const worker = new FakeWorker();
  const controller = new AbortController();
  const adapter = createGoAdapter(options(() => worker));
  const preparing = adapter.prepare(agent, services, { signal: controller.signal });
  controller.abort();
  await expect(preparing).rejects.toMatchObject({ code: 'cancelled' });
  expect(worker.terminated).toBe(true);
});

test('a Go exit marks the Worker dead and the next prepare builds a new one', async () => {
  const workers: FakeWorker[] = [];
  const adapter = createGoAdapter(
    options(() => {
      const worker = new FakeWorker(ready);
      workers.push(worker);
      return worker;
    }),
  );
  const first = await prepare(adapter);
  workers[0]?.emit({ v: 1, kind: 'exit', code: 2 });
  expect(await firstEvent(first)).toMatchObject({ type: 'error', error: { code: 'unavailable' } });
  await first.dispose();
  expect(workers[0]?.terminated).toBe(true);
  const second = await prepare(adapter);
  expect(workers).toHaveLength(2);
  expect(workers[1]?.terminated).toBe(false);
  await second.dispose();
});

test('a Worker error after boot marks the Worker dead', async () => {
  const worker = new FakeWorker(ready);
  const prepared = await prepare(createGoAdapter(options(() => worker)));
  worker.fail();
  expect(await firstEvent(prepared)).toMatchObject({
    type: 'error',
    error: { code: 'unavailable' },
  });
});

test('a throwing createWorker fails unavailable and a throwing onBoot never leaks the Worker', async () => {
  const onBoot = vi.fn();
  await expect(
    prepare(
      createGoAdapter({
        createWorker: () => {
          throw new Error('no Worker');
        },
        onBoot,
      }),
    ),
  ).rejects.toMatchObject({ code: 'unavailable' });
  expect(onBoot.mock.calls.map(([event]) => event)).toEqual([
    { phase: 'booting' },
    { phase: 'failed' },
  ]);
  const worker = new FakeWorker(ready);
  const prepared = await prepare(
    createGoAdapter({
      createWorker: () => worker,
      onBoot: () => {
        throw new Error('observer failed');
      },
    }),
  );
  await prepared.dispose();
  expect(worker.terminated).toBe(true);
});
