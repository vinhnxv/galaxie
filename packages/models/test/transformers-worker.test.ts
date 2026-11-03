// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { ModelError } from '../src/errors.js';
import { createTransformersEngine } from '../src/transformers/engine.js';
import { modelFileUrl } from '../src/transformers/model-record.js';
import type { FromWorker, GenerateRequest } from '../src/transformers/protocol.js';
import { startTransformersWorker } from '../src/transformers/worker.js';
import { createWorkerHost } from '../src/transformers/worker-host.js';
import { createFakeRuntime } from './support/fake-transformers-runtime.js';
import { request, settle } from './support/fake-transformers-worker.js';
import { assets, seed, setup } from './support/transformers-loopback.js';
import {
  createFakeFetch,
  createSyntheticModel,
  MemoryStore,
} from './support/transformers-model.js';

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
    await vi.waitFor(() => expect(runtime.disposed).toBe(1));
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
    host.receive('nonsense');
    host.receive({ type: 'generate', id: -1 });
    await settle();
    expect(posted).toEqual([]);
    // A generate with a usable id but a rejected request is answered, so the page never waits.
    host.receive({ type: 'generate', id: 1 });
    await settle();
    expect(posted).toEqual([{ type: 'failed', id: 1, code: 'invalid' }]);
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

describe('request failures', () => {
  it('fails an oversize request on the page and keeps the handle usable', async () => {
    const { model, worker } = await setup();
    const handle = await createTransformersEngine(
      { worker, model: model.record, allowDownload: true },
      { gpu: undefined },
    );
    const tooLong = {
      ...request,
      messages: [{ role: 'user', content: 'x'.repeat(1_048_577) }],
    } as GenerateRequest;
    await expect(
      (async () => {
        for await (const _ of handle.stream(tooLong));
      })(),
    ).rejects.toMatchObject({ code: 'invalid' });
    const events = [];
    for await (const event of handle.stream(request as GenerateRequest)) events.push(event.type);
    expect(events.at(-1)).toBe('done');
    await handle.dispose();
  });

  it('fails an uncloneable request and releases the turn', async () => {
    const { model, worker } = await setup();
    const handle = await createTransformersEngine(
      { worker, model: model.record, allowDownload: true },
      { gpu: undefined },
    );
    const original = worker.postMessage.bind(worker);
    let throwOnce = true;
    worker.postMessage = (message: unknown): void => {
      if (throwOnce && (message as { type?: string }).type === 'generate') {
        throwOnce = false;
        throw new DOMException('not cloneable', 'DataCloneError');
      }
      original(message);
    };
    await expect(
      (async () => {
        for await (const _ of handle.stream(request as GenerateRequest));
      })(),
    ).rejects.toMatchObject({ code: 'invalid' });
    const events = [];
    for await (const event of handle.stream(request as GenerateRequest)) events.push(event.type);
    expect(events.at(-1)).toBe('done');
    await handle.dispose();
  });

  it('answers a JSON schema request as unsupported', async () => {
    const { model, worker } = await setup();
    const handle = await createTransformersEngine(
      { worker, model: model.record, allowDownload: true },
      { gpu: undefined },
    );
    await expect(
      (async () => {
        for await (const _ of handle.stream({
          ...request,
          jsonSchema: { type: 'object' },
        } as GenerateRequest));
      })(),
    ).rejects.toMatchObject({ code: 'unsupported' });
    await handle.dispose();
  });

  it('waits for a running generation before releasing the runtime on dispose', async () => {
    const model = await createSyntheticModel();
    const runtime = createFakeRuntime({ holdAfter: 1 });
    const posted: FromWorker[] = [];
    let releasedWhileRunning = false;
    const real = runtime.load.bind(runtime);
    runtime.load = async (options) => {
      const loaded = await real(options);
      let running = false;
      return {
        ...loaded,
        async generate(generation) {
          running = true;
          try {
            return await loaded.generate(generation);
          } finally {
            await new Promise<void>((resolve) => setTimeout(resolve, 20));
            running = false;
          }
        },
        async dispose() {
          releasedWhileRunning = running;
          await loaded.dispose();
        },
      };
    };
    const host = createWorkerHost({
      post: (message) => posted.push(message),
      runtime,
      assets,
      openStore: async () => new MemoryStore(),
      fetch: createFakeFetch(model.served).fetch,
    });
    host.receive({ type: 'load', record: model.record, allowDownload: true });
    await vi.waitFor(() => expect(posted.at(-1)).toMatchObject({ type: 'ready' }));
    host.receive({ type: 'generate', id: 1, request });
    await vi.waitFor(() => expect(posted.some((message) => message.type === 'chunk')).toBe(true));
    host.receive({ type: 'dispose' });
    await vi.waitFor(() => expect(runtime.disposed).toBe(1));
    expect(releasedWhileRunning).toBe(false);
  });
});
