// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import {
  createWebLLMEngine,
  loadWebLLMEngine,
  type WebLLMProgress,
  type WebLLMRequest,
} from '../src/webllm/engine.js';
import { defaultWebLLMModel } from '../src/webllm/model-record.js';
import {
  createFakeWebLLM,
  type FakeWebLLMOptions,
  FakeWebLLMStream,
} from './support/fake-webllm.js';

describe('WebLLM engine loading and lifetime', () => {
  it('public loading without WebGPU never loads the real engine bundle', async () => {
    const fake = createFakeWebLLM();
    vi.stubGlobal('navigator', {});
    try {
      await expect(loadWebLLMEngine({ worker: fake.worker })).rejects.toMatchObject({
        code: 'unavailable',
        reason: 'no_webgpu',
      });
      expect(fake.worker.messages).toEqual([]);
      expect(fake.constructions).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it.each(['no_webgpu', 'no_adapter', 'no_shader_f16'] as const)(
    'rejects %s before importing or posting to the worker',
    async (reason) => {
      const fake = createFakeWebLLM();
      const loadModule = vi.fn(async () => fake.module);
      const gpu =
        reason === 'no_webgpu'
          ? undefined
          : {
              async requestAdapter() {
                return reason === 'no_adapter' ? null : { features: new Set<string>(), info: {} };
              },
            };
      await expect(
        createWebLLMEngine({ worker: fake.worker }, { gpu, loadModule }),
      ).rejects.toMatchObject({ code: 'unavailable', reason });
      expect(loadModule).not.toHaveBeenCalled();
      expect(fake.constructions).toBe(0);
      expect(fake.worker.messages).toEqual([]);
    },
  );

  it('validates before importing and uses the high-performance page adapter report', async () => {
    const fake = createFakeWebLLM();
    const requestAdapter = vi.fn(fake.gpu.requestAdapter);
    const loadModule = vi.fn(async () => fake.module);
    await expect(
      createWebLLMEngine(
        { worker: fake.worker, model: { ...defaultWebLLMModel, modelUrl: 'invalid' } },
        { gpu: fake.gpu, loadModule },
      ),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(loadModule).not.toHaveBeenCalled();
    const handle = await createWebLLMEngine(
      { worker: fake.worker },
      { gpu: { requestAdapter }, loadModule },
    );
    expect(requestAdapter).toHaveBeenCalledWith({ powerPreference: 'high-performance' });
    expect(handle.device).toEqual({
      backend: 'webgpu',
      thread: 'worker',
      vendor: 'fake-vendor',
      architecture: 'fake-architecture',
    });
    expect(handle.modelId).toBe(defaultWebLLMModel.modelId);
    expect(fake.engine.reloads).toEqual([defaultWebLLMModel.modelId]);
    await handle.dispose();
  });

  it('reports pass-local fractions and elapsed time without engine text', async () => {
    const fake = createFakeWebLLM();
    const reports: WebLLMProgress[] = [];
    const handle = await createWebLLMEngine(
      { worker: fake.worker, onProgress: (value) => reports.push(value) },
      { gpu: fake.gpu, loadModule: async () => fake.module },
    );
    for (const report of [
      { text: 'Fetching param cache[1/30]: private engine text', progress: 0.5, timeElapsed: 2 },
      {
        text: 'Loading model from cache[1/30]: private engine text',
        progress: 0.1,
        timeElapsed: 3,
      },
      {
        text: 'Loading GPU shader modules[1/10]: private engine text',
        progress: 0.2,
        timeElapsed: 4,
      },
      { text: 'unrecognized private engine text', progress: 0.6, timeElapsed: 5 },
    ])
      fake.engine.config.initProgressCallback(report);
    expect(reports).toEqual([
      { phase: 'download', fraction: 0.5, elapsedSeconds: 2 },
      { phase: 'load', fraction: 0.1, elapsedSeconds: 3 },
      { phase: 'load', fraction: 0.2, elapsedSeconds: 4 },
      { phase: 'unknown', fraction: 0.6, elapsedSeconds: 5 },
    ]);
    expect(JSON.stringify(reports)).not.toContain('private');
    await handle.dispose();
  });

  it('drops a rejected engine string and cleans up a failed load', async () => {
    const fake = createFakeWebLLM({
      reload: async () => {
        throw 'IntegrityError: private engine text';
      },
    });
    const error = await createWebLLMEngine(
      { worker: fake.worker },
      { gpu: fake.gpu, loadModule: async () => fake.module },
    ).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'unavailable', reason: 'integrity' });
    expect(error).not.toHaveProperty('cause');
    expect(JSON.stringify(error)).not.toContain('private');
    expect((error as Error).message).not.toContain('private');
    expect(fake.engine.unloads).toBe(1);
    expect(fake.worker.terminations).toBe(1);
  });

  it('aborts a pending reload, unloads and terminates even when reload later resolves', async () => {
    const entered = Promise.withResolvers<void>();
    const reload = Promise.withResolvers<void>();
    const fake = createFakeWebLLM({
      reload: async () => {
        entered.resolve();
        await reload.promise;
      },
    });
    const controller = new AbortController();
    const loading = createWebLLMEngine(
      { worker: fake.worker, signal: controller.signal },
      { gpu: fake.gpu, loadModule: async () => fake.module },
    );
    const rejection = expect(loading).rejects.toBe('host-abort');
    await entered.promise;
    controller.abort('host-abort');
    await rejection;
    reload.resolve();
    expect(fake.engine.unloads).toBe(1);
    expect(fake.worker.terminations).toBe(1);
  });

  it.each(['error', 'messageerror'] as const)(
    'worker %s rejects pending load without awaiting the engine',
    async (kind) => {
      const entered = Promise.withResolvers<void>();
      const fake = createFakeWebLLM({
        reload: async () => {
          entered.resolve();
          await new Promise(() => {});
        },
      });
      const loading = createWebLLMEngine(
        { worker: fake.worker },
        { gpu: fake.gpu, loadModule: async () => fake.module },
      );
      const rejection = expect(loading).rejects.toMatchObject({
        code: 'unavailable',
        reason: 'worker_failed',
      });
      await entered.promise;
      fake.worker.fail(kind);
      await rejection;
      expect(fake.worker.terminations).toBe(1);
    },
  );

  it('disposes once even if unload never answers', async () => {
    const fake = createFakeWebLLM({ unload: () => new Promise(() => {}) });
    const handle = await createWebLLMEngine(
      { worker: fake.worker },
      { gpu: fake.gpu, loadModule: async () => fake.module },
    );
    await Promise.all([handle.dispose(), handle.dispose()]);
    await handle.dispose();
    expect(fake.engine.unloads).toBe(1);
    expect(fake.worker.terminations).toBe(1);
  });
});

const request: WebLLMRequest = {
  messages: [{ role: 'user', content: 'queue request' }],
  stream: true,
  stream_options: { include_usage: true },
  max_tokens: 64,
  temperature: 0,
};
async function queuedEngine(options: FakeWebLLMOptions = {}) {
  const fake = createFakeWebLLM(options);
  const handle = await createWebLLMEngine(
    { worker: fake.worker },
    { gpu: fake.gpu, loadModule: async () => fake.module },
  );
  return { ...fake, engine: fake.engine, handle };
}
async function drain(iterator: AsyncIterable<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = [];
  for await (const chunk of iterator) chunks.push(chunk);
  return chunks;
}

describe('WebLLM FIFO requests and cancellation', () => {
  it('resets before each request and waits for stream closure before the next reset', async () => {
    const returning = Promise.withResolvers<void>();
    const returned = Promise.withResolvers<void>();
    const firstStream = new FakeWebLLMStream([], {
      beforeReturn: async () => {
        returning.resolve();
        await returned.promise;
      },
    });
    let created = 0;
    const { engine, handle } = await queuedEngine({
      create: async () => (created++ === 0 ? firstStream : new FakeWebLLMStream()),
    });
    const first = drain(handle.stream(request));
    const second = drain(handle.stream(request));
    await returning.promise;
    expect(engine.events).toEqual(['reset', 'create']);
    returned.resolve();
    await Promise.all([first, second]);
    expect(engine.events).toEqual(['reset', 'create', 'closed', 'reset', 'create', 'closed']);
    expect(engine.requests).toEqual([request, request]);
    engine.assertClosed();
    await handle.dispose();
  });

  it('removes queued aborts without dispatch and preserves the next turn', async () => {
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const firstStream = new FakeWebLLMStream([], {
      beforeNext: async () => {
        entered.resolve();
        await gate.promise;
      },
    });
    let created = 0;
    const { engine, handle } = await queuedEngine({
      create: async () => (created++ === 0 ? firstStream : new FakeWebLLMStream()),
    });
    const first = drain(handle.stream(request));
    await entered.promise;
    const controller = new AbortController();
    const aborted = drain(handle.stream(request, controller.signal));
    const rejected = expect(aborted).rejects.toBe('queued-abort');
    const last = drain(handle.stream(request));
    controller.abort('queued-abort');
    await rejected;
    expect(engine.resets).toBe(1);
    gate.resolve();
    await Promise.all([first, last]);
    expect(engine.resets).toBe(2);
    engine.assertClosed();
    await handle.dispose();
  });

  it('interrupts and closes once after two chunks, dropping all late chunks and usage', async () => {
    const { engine, handle } = await queuedEngine();
    const controller = new AbortController();
    const iterator = handle.stream(request, controller.signal);
    expect((await iterator.next()).done).toBe(false);
    expect((await iterator.next()).done).toBe(false);
    controller.abort('running-abort');
    await expect(iterator.next()).rejects.toBe('running-abort');
    expect(engine.interrupts).toBe(1);
    expect(engine.streams[0]?.returns).toBe(1);
    engine.assertClosed();
    await handle.dispose();
  });

  it('returns a stream aborted during create without ever pulling its first chunk', async () => {
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const stream = new FakeWebLLMStream();
    const { engine, handle } = await queuedEngine({
      create: async () => {
        entered.resolve();
        await gate.promise;
        return stream;
      },
    });
    const controller = new AbortController();
    const running = drain(handle.stream(request, controller.signal));
    const rejected = expect(running).rejects.toBe('early-abort');
    await entered.promise;
    controller.abort('early-abort');
    const next = drain(handle.stream(request));
    expect(engine.requests).toHaveLength(1);
    gate.resolve();
    await rejected;
    expect(stream.nexts).toBe(0);
    expect(stream.returns).toBe(1);
    await next;
    engine.assertClosed();
    await handle.dispose();
  });

  it('closes when the consumer stops early', async () => {
    const { engine, handle } = await queuedEngine();
    for await (const _chunk of handle.stream(request)) break;
    expect(engine.streams[0]?.returns).toBe(1);
    engine.assertClosed();
    await handle.dispose();
  });

  it('drops an outstanding late finish chunk after abort without waiting for it', async () => {
    const entered = Promise.withResolvers<void>();
    const late = Promise.withResolvers<void>();
    const stream = new FakeWebLLMStream(undefined, {
      beforeNext: async (index) => {
        if (index === 2) {
          entered.resolve();
          await late.promise;
        }
      },
    });
    const { engine, handle } = await queuedEngine({ create: async () => stream });
    const controller = new AbortController();
    const iterator = handle.stream(request, controller.signal);
    await iterator.next();
    await iterator.next();
    const pending = iterator.next();
    const rejected = expect(pending).rejects.toBe('late-abort');
    await entered.promise;
    controller.abort('late-abort');
    await rejected;
    expect(engine.interrupts).toBe(1);
    expect(stream.returns).toBe(1);
    late.resolve();
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    engine.assertClosed();
    await handle.dispose();
  });

  it.each(['worker', 'dispose'] as const)(
    '%s failure rejects running, queued and later requests without waiting for next',
    async (kind) => {
      const entered = Promise.withResolvers<void>();
      const stream = new FakeWebLLMStream([], {
        beforeNext: async () => {
          entered.resolve();
          await new Promise(() => {});
        },
      });
      const { engine, handle, worker } = await queuedEngine({ create: async () => stream });
      const running = drain(handle.stream(request));
      const firstRejected = expect(running).rejects.toMatchObject({
        code: 'unavailable',
        reason: kind === 'worker' ? 'worker_failed' : 'disposed',
      });
      await entered.promise;
      const queued = drain(handle.stream(request));
      const secondRejected = expect(queued).rejects.toMatchObject({ code: 'unavailable' });
      if (kind === 'worker') worker.fail();
      else await handle.dispose();
      await Promise.all([firstRejected, secondRejected]);
      await expect(drain(handle.stream(request))).rejects.toMatchObject({ code: 'unavailable' });
      expect(engine.requests).toHaveLength(1);
      engine.assertClosed();
      await handle.dispose();
    },
  );

  it('maps prefill context failures to invalid and still runs the next queued request', async () => {
    const stream = new FakeWebLLMStream([], {
      beforeNext: async () => {
        throw 'ContextWindowSizeExceededError: private engine text';
      },
    });
    let created = 0;
    const { engine, handle } = await queuedEngine({
      create: async () => (created++ === 0 ? stream : new FakeWebLLMStream()),
    });
    const failed = drain(handle.stream(request));
    const rejected = expect(failed).rejects.toMatchObject({ code: 'invalid' });
    const next = drain(handle.stream(request));
    await rejected;
    await next;
    expect(engine.resets).toBe(2);
    engine.assertClosed();
    await handle.dispose();
  });

  it('sanitizes unknown create failures', async () => {
    const { engine, handle } = await queuedEngine({
      create: async () => {
        throw 'private engine text';
      },
    });
    const error = await drain(handle.stream(request)).catch((value: unknown) => value);
    expect(error).toMatchObject({
      name: 'WebLLMProviderError',
      message: 'The WebLLM provider failed.',
    });
    expect(error).not.toHaveProperty('cause');
    expect(JSON.stringify(error)).not.toContain('private');
    engine.assertClosed();
    await handle.dispose();
  });

  it('makes device loss terminal for current and later requests', async () => {
    const { engine, handle } = await queuedEngine({
      create: async () => {
        throw 'DeviceLostError: private engine text';
      },
    });
    await expect(drain(handle.stream(request))).rejects.toMatchObject({
      code: 'unavailable',
      reason: 'device_lost',
    });
    await expect(drain(handle.stream(request))).rejects.toMatchObject({
      code: 'unavailable',
      reason: 'device_lost',
    });
    expect(engine.requests).toHaveLength(1);
    engine.assertClosed();
    await handle.dispose();
  });
});
