// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { createWebLLMEngine, loadWebLLMEngine, type WebLLMProgress } from '../src/webllm/engine.js';
import { defaultWebLLMModel } from '../src/webllm/model-record.js';
import { createFakeWebLLM } from './support/fake-webllm.js';

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
