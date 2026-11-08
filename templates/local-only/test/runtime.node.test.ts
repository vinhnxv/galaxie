// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { ModelError, type ModelUnavailableReason } from '@galaxie-ai/models/builtin-ai';
import type { WebLLMEngineHandle } from '@galaxie-ai/models/webllm';
import { afterEach, expect, it, vi } from 'vitest';
import { createTemplateHost, type TemplateInstance } from '../src/runtime.js';

afterEach(() => vi.unstubAllGlobals());

async function answer(instance: TemplateInstance): Promise<unknown> {
  await instance.prepare();
  const { runId } = await instance.start({});
  await expect.poll(() => instance.getSnapshot().run?.status).toBe('waiting_input');
  const pending = instance.getSnapshot().run?.pending;
  if (pending === undefined) throw new Error('The question did not pause.');
  expect(
    await instance.dispatch({
      ...pending,
      instanceId: instance.instanceId,
      runId,
      action: 'submit',
      payload: { answers: { sum: 'four' } },
    }),
  ).toMatchObject({ status: 'accepted' });
  await expect.poll(() => instance.getSnapshot().run?.status).toBe('succeeded');
  let output: unknown;
  for await (const event of instance.events(runId))
    if (event.type === 'output') output = event.output;
  return output;
}

it('finishes on the scripted model without a network request, worker, or WebLLM load', async () => {
  const network = vi.fn(() => {
    throw new Error('No network is allowed.');
  });
  vi.stubGlobal('fetch', network);
  vi.stubGlobal('WebSocket', network);
  vi.stubGlobal('XMLHttpRequest', network);
  vi.stubGlobal('Worker', network);
  const loader = vi.fn(async () => {
    throw new Error('No WebLLM load is allowed.');
  });
  const host = await createTemplateHost({
    builtInAIProbe: async () => 'unavailable',
    webGPUProbe: () => false,
    webLLMLoader: loader,
  });
  try {
    expect(host.getModelSnapshot()).toMatchObject({
      route: 'mock',
      builtinReason: 'no_api',
      webllm: 'no_webgpu',
    });
    expect(await answer(await host.createInstance())).toEqual({
      result: 'Correct. Keep practicing one small step at a time.',
    });
    expect(network).not.toHaveBeenCalled();
    expect(loader).not.toHaveBeenCalled();
  } finally {
    await host.dispose();
  }
});

it.each<ModelUnavailableReason>([
  'no_api',
  'unsupported_languages',
  'download_required',
  'activation_required',
  'download_failed',
  'not_allowed',
  'no_webgpu',
  'no_adapter',
  'no_shader_f16',
  'adapter_limits',
  'device_lost',
  'integrity',
  'worker_failed',
  'load_failed',
  'disposed',
  'rate_limited',
  'endpoint_failed',
  'network',
])('maps the typed %s probe failure to a fixed state and keeps the mock', async (reason) => {
  const host = await createTemplateHost({
    builtInAIProbe: async () => {
      throw new ModelError('unavailable', reason);
    },
    webGPUProbe: () => true,
  });
  try {
    expect(host.getModelSnapshot()).toMatchObject({
      route: 'mock',
      builtinReason: reason,
      webllm: 'offer',
    });
  } finally {
    await host.dispose();
  }
});

it('selects available Built-in AI without preparing or offering a download', async () => {
  const loader = vi.fn(async () => {
    throw new Error('The loader must not run.');
  });
  const host = await createTemplateHost({
    builtInAIProbe: async () => 'available',
    webGPUProbe: () => true,
    webLLMLoader: loader,
  });
  try {
    expect(host.getModelSnapshot()).toMatchObject({
      route: 'builtin',
      builtinReason: undefined,
      webllm: undefined,
    });
    await host.downloadWebLLM();
    expect(loader).not.toHaveBeenCalled();
  } finally {
    await host.dispose();
  }
});

it.each(['downloadable', 'downloading'] as const)(
  'leaves Built-in AI %s on the mock without downloading',
  async (status) => {
    const host = await createTemplateHost({
      builtInAIProbe: async () => status,
      webGPUProbe: () => true,
    });
    try {
      expect(host.getModelSnapshot()).toMatchObject({
        route: 'mock',
        builtinReason: 'download_required',
      });
    } finally {
      await host.dispose();
    }
  },
);

it('distinguishes an existing API with unavailable English from a missing API', async () => {
  vi.stubGlobal('LanguageModel', {});
  const host = await createTemplateHost({
    builtInAIProbe: async () => 'unavailable',
    webGPUProbe: () => false,
  });
  try {
    expect(host.getModelSnapshot().builtinReason).toBe('unsupported_languages');
  } finally {
    await host.dispose();
  }
});

it('ignores late progress and disposes a late engine after cancellation', async () => {
  const pending = Promise.withResolvers<WebLLMEngineHandle>();
  let report: ((fraction: number) => void) | undefined;
  const dispose = vi.fn(async () => {});
  const host = await createTemplateHost({
    builtInAIProbe: async () => 'unavailable',
    webGPUProbe: () => true,
    webLLMLoader: async ({ onProgress }) => {
      report = (fraction) => onProgress({ phase: 'download', fraction, elapsedSeconds: 0 });
      return pending.promise;
    },
  });
  try {
    const downloading = host.downloadWebLLM();
    host.cancelDownload();
    report?.(1);
    pending.resolve({ dispose } as unknown as WebLLMEngineHandle);
    await downloading;
    expect(dispose).toHaveBeenCalledOnce();
    expect(host.getModelSnapshot()).toMatchObject({ route: 'mock', webllm: 'offer', progress: 0 });
  } finally {
    await host.dispose();
  }
});
