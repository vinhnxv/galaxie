// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test, vi } from 'vitest';
import { createGoAdapter, GO_EXECUTOR_ID, type GoAgent, type GoWorkerPort } from '../src/index.js';
import { encodeWorkerMessage, type WorkerMessage } from '../src/protocol.js';

const agent: GoAgent = {
  wasm: { url: 'http://127.0.0.1/go/agent.wasm', sha256: 'a'.repeat(64), bytes: 1024 },
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
const prepare = (adapter: ReturnType<typeof createGoAdapter>, value: unknown = agent) =>
  adapter.prepare(value as GoAgent, undefined, { signal: new AbortController().signal });

test('the adapter registers adk-go with every feature off', () => {
  const adapter = createGoAdapter(options(() => new FakeWorker(ready)));
  expect(adapter.id).toBe('adk-go');
  expect(GO_EXECUTOR_ID).toBe('adk-go');
  expect(adapter.features).toEqual({
    interrupts: false,
    resume: false,
    checkpoints: false,
    streaming: false,
    subgraphs: false,
  });
});

test('prepare boots a Worker with the reviewed module and a run fails unsupported', async () => {
  const worker = new FakeWorker(ready);
  const onBoot = vi.fn();
  const adapter = createGoAdapter({ ...options(() => worker), onBoot });
  const prepared = await prepare(adapter);
  expect(worker.sent).toEqual([{ v: 1, kind: 'boot', wasm: agent.wasm }]);
  expect(onBoot.mock.calls.map(([event]) => event)).toEqual([
    { phase: 'booting' },
    { phase: 'ready', coldStartMs: 12 },
  ]);
  const iterator = prepared.run({} as never)[Symbol.asyncIterator]();
  await expect(iterator.next()).rejects.toMatchObject({ code: 'unsupported' });
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
  ['no agent', null],
])('%s fails invalid before a Worker exists', async (_name, value) => {
  const createWorker = vi.fn(() => new FakeWorker(ready));
  await expect(prepare(createGoAdapter({ createWorker }), value)).rejects.toMatchObject({
    code: 'invalid',
  });
  expect(createWorker).not.toHaveBeenCalled();
});

test('services are refused until the model bridge exists', async () => {
  const adapter = createGoAdapter(options(() => new FakeWorker(ready)));
  await expect(
    adapter.prepare(agent, {} as unknown as undefined, { signal: new AbortController().signal }),
  ).rejects.toMatchObject({ code: 'invalid' });
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
  const preparing = adapter.prepare(agent, undefined, { signal: controller.signal });
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
  await expect(
    first
      .run({} as never)
      [Symbol.asyncIterator]()
      .next(),
  ).rejects.toMatchObject({
    code: 'unavailable',
  });
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
  await expect(
    prepared
      .run({} as never)
      [Symbol.asyncIterator]()
      .next(),
  ).rejects.toMatchObject({
    code: 'unavailable',
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
