// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, test, vi } from 'vitest';
import { probeWebLLMModel } from '../src/webllm/cache.js';
import { checkWebLLMModel } from '../src/webllm/index.js';
import { buildAppConfig, defaultWebLLMModel } from '../src/webllm/model-record.js';
import { createFakeWebLLMCache } from './support/fake-webllm.js';

afterEach(() => vi.unstubAllGlobals());

test('no WebGPU is unavailable without loading the module', async () => {
  vi.stubGlobal('navigator', {});
  const fake = createFakeWebLLMCache();
  const loadModule = vi.fn(async () => fake.module);
  expect(await probeWebLLMModel({}, loadModule)).toEqual({ status: 'unavailable' });
  expect(loadModule).not.toHaveBeenCalled();
  expect(await checkWebLLMModel()).toEqual({ status: 'unavailable' });
  expect(fake.checks).toEqual([]);
});

test.each([true, false])(
  'cached weights %s report readiness without constructing an engine',
  async (cached) => {
    vi.stubGlobal('navigator', { gpu: {} });
    const fake = createFakeWebLLMCache(async () => cached);
    const loadModule = vi.fn(async () => fake.module);
    const model = { ...defaultWebLLMModel, modelId: 'host-model', weightBytes: 123 };
    expect(await probeWebLLMModel({ model }, loadModule)).toEqual(
      cached ? { status: 'available' } : { status: 'downloadable', bytes: 123, siteStorage: true },
    );
    expect(loadModule).toHaveBeenCalledTimes(1);
    expect(fake.checks).toEqual([{ modelId: 'host-model', appConfig: buildAppConfig(model) }]);
  },
);

test('the default model record supplies the reported weight size', async () => {
  vi.stubGlobal('navigator', { gpu: {} });
  const fake = createFakeWebLLMCache(async () => false);
  expect(await probeWebLLMModel({}, async () => fake.module)).toEqual({
    status: 'downloadable',
    bytes: defaultWebLLMModel.weightBytes,
    siteStorage: true,
  });
});

test.each(['import', 'cache'] as const)(
  '%s failures are unavailable without error text',
  async (kind) => {
    vi.stubGlobal('navigator', { gpu: {} });
    const failure = new Error('private cache failure');
    const fake = createFakeWebLLMCache(async () => {
      throw failure;
    });
    expect(
      await probeWebLLMModel({}, async () => {
        if (kind === 'import') throw failure;
        return fake.module;
      }),
    ).toEqual({ status: 'unavailable' });
  },
);

test.each([true, false])(
  'record validation precedes the GPU and module checks: GPU %s',
  async (gpu) => {
    vi.stubGlobal('navigator', gpu ? { gpu: {} } : {});
    const loadModule = vi.fn(async () => createFakeWebLLMCache().module);
    const model = { ...defaultWebLLMModel, weightBytes: -1 };
    const waiting = probeWebLLMModel({ model }, loadModule);
    await expect(waiting).rejects.toMatchObject({ code: 'invalid' });
    await expect(waiting).rejects.not.toHaveProperty('cause');
    expect(loadModule).not.toHaveBeenCalled();
    await expect(checkWebLLMModel({ model })).rejects.toMatchObject({ code: 'invalid' });
  },
);
