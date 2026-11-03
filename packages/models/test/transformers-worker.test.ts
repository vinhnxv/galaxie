// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { ModelError } from '../src/errors.js';
import { createTransformersEngine, type TransformersWorker } from '../src/transformers/engine.js';
import { storedBytesHeader, storedSha256Header } from '../src/transformers/model-files.js';
import { modelFileUrl } from '../src/transformers/model-record.js';
import type { FromWorker, GenerateRequest } from '../src/transformers/protocol.js';
import { startTransformersWorker } from '../src/transformers/worker.js';
import { createWorkerHost, type WorkerHost } from '../src/transformers/worker-host.js';
import { createFakeRuntime, type FakeRuntimeOptions } from './support/fake-transformers-runtime.js';
import { request, settle } from './support/fake-transformers-worker.js';
import {
  createFakeFetch,
  createSyntheticModel,
  MemoryStore,
  type SyntheticModel,
} from './support/transformers-model.js';

const assets = { mjs: 'https://app.test/ort.mjs', wasm: 'https://app.test/ort.wasm' };

/** Runs the page engine against the Worker host in one process, through structured clones. */
class LoopbackWorker implements TransformersWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly toWorker: unknown[] = [];
  terminated = 0;
  host: WorkerHost | undefined;

  postMessage(message: unknown): void {
    const copy = structuredClone(message);
    this.toWorker.push(copy);
    queueMicrotask(() => this.host?.receive(copy));
  }

  terminate(): void {
    this.terminated += 1;
  }

  deliver(message: FromWorker): void {
    const copy = structuredClone(message);
    queueMicrotask(() => this.onmessage?.({ data: copy } as MessageEvent));
  }
}

async function setup(
  options: {
    model?: SyntheticModel;
    runtime?: FakeRuntimeOptions;
    store?: MemoryStore;
    served?: boolean;
  } = {},
) {
  const model = options.model ?? (await createSyntheticModel());
  const store = options.store ?? new MemoryStore();
  const runtime = createFakeRuntime(options.runtime);
  const fetcher = createFakeFetch(model.served);
  const worker = new LoopbackWorker();
  worker.host = createWorkerHost({
    post: (message) => worker.deliver(message),
    runtime,
    assets,
    openStore: async () => store,
    fetch: fetcher.fetch,
    now: () => 0,
  });
  return { model, store, runtime, fetcher, worker };
}

async function seed(store: MemoryStore, model: SyntheticModel): Promise<void> {
  for (const file of model.record.files) {
    const url = modelFileUrl(model.record, file);
    store.entries.set(url, {
      bytes: model.served.get(url) as Uint8Array<ArrayBuffer>,
      headers: [
        [storedBytesHeader, String(file.bytes)],
        [storedSha256Header, file.sha256],
      ],
    });
  }
}

describe('worker host', () => {
  it('loads through the verified store, reports phases in order and answers a generation', async () => {
    const { model, runtime, worker, fetcher } = await setup();
    const phases: string[] = [];
    const handle = await createTransformersEngine(
      {
        worker,
        model: model.record,
        allowDownload: true,
        onProgress: (item) => {
          if (phases.at(-1) !== item.phase) phases.push(item.phase);
        },
      },
      { gpu: undefined },
    );
    // Files are fetched and verified one after another, then the runtime loads.
    expect(phases[0]).toBe('download');
    expect(phases.at(-1)).toBe('load');
    expect(phases.indexOf('load')).toBe(phases.length - 1);
    expect(new Set(phases)).toEqual(new Set(['download', 'verify', 'load']));
    expect(handle.device.backend).toBe('wasm');
    expect(runtime.loads).toHaveLength(1);
    expect(runtime.loads[0]?.assets).toEqual(assets);
    expect(fetcher.calls).toHaveLength(model.urls.length);
    for (const file of model.record.files)
      expect(runtime.read.get(file.path)).toEqual(
        model.served.get(modelFileUrl(model.record, file)),
      );
    const events = [];
    for await (const event of handle.stream(request as GenerateRequest)) events.push(event);
    expect(events).toEqual([
      { type: 'chunk', text: 'Hello' },
      { type: 'chunk', text: ' world' },
      { type: 'done', usage: { promptTokens: 5, completionTokens: 2 }, finishReason: 'stop' },
    ]);
    expect(runtime.generations[0]?.contextWindow).toBe(2048);
    await handle.dispose();
    expect(runtime.disposed).toBe(1);
    expect(worker.terminated).toBe(1);
  });

  it('loads stored files without any fetch when downloads are not allowed', async () => {
    const { model, store, runtime, fetcher, worker } = await setup();
    await seed(store, model);
    const handle = await createTransformersEngine(
      { worker, model: model.record },
      { gpu: undefined },
    );
    expect(fetcher.calls).toEqual([]);
    expect(runtime.loads).toHaveLength(1);
    await handle.dispose();
  });

  it('fails an altered stored file with integrity, without a fetch or a runtime call', async () => {
    const { model, store, runtime, fetcher, worker } = await setup();
    await seed(store, model);
    const first = store.entries.get(model.urls[0] as string);
    if (first === undefined) throw new Error('missing seed');
    first.bytes = new Uint8Array(first.bytes.length).fill(7);
    await expect(
      createTransformersEngine({ worker, model: model.record }, { gpu: undefined }),
    ).rejects.toMatchObject({ code: 'unavailable', reason: 'integrity' });
    expect(fetcher.calls).toEqual([]);
    expect(runtime.loads).toEqual([]);
    expect(worker.terminated).toBe(1);
  });

  it('reports a runtime load failure with a fixed code and drops the verified buffers', async () => {
    const { model, runtime, worker } = await setup({
      runtime: { loadError: new Error('secret internal detail about /home/user') },
    });
    const error = await createTransformersEngine(
      { worker, model: model.record, allowDownload: true },
      { gpu: undefined },
    ).catch((caught: unknown) => caught);
    expect(error).toBeDefined();
    expect(String((error as Error).message)).not.toContain('secret');
    expect(runtime.loads).toHaveLength(1);
    expect(worker.terminated).toBe(1);
  });

  it('aborts a running generation and reports the abort finish reason', async () => {
    const { model, worker } = await setup({ runtime: { holdAfter: 1 } });
    const handle = await createTransformersEngine(
      { worker, model: model.record, allowDownload: true },
      { gpu: undefined },
    );
    const controller = new AbortController();
    const received: string[] = [];
    const run = (async () => {
      for await (const event of handle.stream(request as GenerateRequest, controller.signal))
        received.push(event.type);
    })();
    const outcome = run.then(
      () => 'ok',
      (error: unknown) => error,
    );
    await settle();
    controller.abort(new Error('halt'));
    expect(await outcome).toEqual(new Error('halt'));
    await settle();
    // The next request runs once the aborted one has finished on the Worker side.
    const next = [];
    for await (const event of handle.stream(request as GenerateRequest)) next.push(event.type);
    expect(next.at(-1)).toBe('done');
    expect(received).toEqual(['chunk']);
  });

  it('maps a generation failure to a fixed code and keeps the handle usable for classified errors', async () => {
    const { model, worker } = await setup({
      runtime: { generateError: new ModelError('invalid') },
    });
    const handle = await createTransformersEngine(
      { worker, model: model.record, allowDownload: true },
      { gpu: undefined },
    );
    await expect(
      (async () => {
        for await (const _ of handle.stream(request as GenerateRequest));
      })(),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('ignores messages that do not match the protocol', async () => {
    const { model, runtime } = await setup();
    const posted: FromWorker[] = [];
    const host = createWorkerHost({
      post: (message) => posted.push(message),
      runtime,
      assets,
      openStore: async () => new MemoryStore(),
    });
    host.receive({ type: 'load', record: { ...model.record, device: 'cpu' }, allowDownload: true });
    host.receive({ type: 'generate', id: 1 });
    host.receive('nonsense');
    await settle();
    expect(posted).toEqual([]);
    expect(runtime.loads).toEqual([]);
  });

  it('refuses a generation before a load and a second load', async () => {
    const { model, runtime } = await setup();
    const posted: FromWorker[] = [];
    const host = createWorkerHost({
      post: (message) => posted.push(message),
      runtime,
      assets,
      openStore: async () => new MemoryStore(),
      fetch: createFakeFetch(model.served).fetch,
    });
    host.receive({ type: 'generate', id: 1, request });
    await settle();
    expect(posted).toEqual([{ type: 'failed', id: 1, code: 'provider' }]);
    posted.length = 0;
    host.receive({ type: 'load', record: model.record, allowDownload: true });
    await vi.waitFor(() => expect(posted.at(-1)).toMatchObject({ type: 'ready' }));
    posted.length = 0;
    host.receive({ type: 'load', record: model.record, allowDownload: true });
    await settle();
    expect(posted).toEqual([{ type: 'failed', code: 'provider' }]);
    expect(runtime.loads).toHaveLength(1);
  });
});

describe('worker entry', () => {
  it('starts nothing on import and refuses a window scope', () => {
    expect(() =>
      startTransformersWorker({ ort: assets }, {
        postMessage() {},
        addEventListener() {},
        document: {},
      } as never),
    ).toThrow('worker scope');
  });

  it('starts once per scope, validates messages and answers through the injected runtime', async () => {
    const listeners: ((event: MessageEvent) => void)[] = [];
    const sent: unknown[] = [];
    const scope = {
      postMessage(message: unknown) {
        sent.push(message);
      },
      addEventListener(_type: 'message', listener: (event: MessageEvent) => void) {
        listeners.push(listener);
      },
    };
    startTransformersWorker({ ort: assets, runtime: createFakeRuntime() }, scope);
    expect(listeners).toHaveLength(1);
    expect(() => startTransformersWorker({ ort: assets }, scope)).toThrow('already started');
    listeners[0]?.({ data: { type: 'nonsense' } } as MessageEvent);
    listeners[0]?.({ data: { type: 'generate', id: 3, request } } as MessageEvent);
    await settle();
    expect(sent).toEqual([{ type: 'failed', id: 3, code: 'provider' }]);
  });
});
