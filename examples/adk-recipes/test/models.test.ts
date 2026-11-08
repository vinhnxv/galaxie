// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import '../src/host/adk-env.js';
import { createAdkAdapter } from '@galaxie-ai/adapter-adk';
import { createRuntime, type ModelRouting } from '@galaxie-ai/core';
import { parseModelRecord } from '@galaxie-ai/models/transformers';
import { afterEach, expect, test, vi } from 'vitest';
import { templateOptions } from '../../../packages/models/src/transformers/runtime.js';
import { seed, setup } from '../../../packages/models/test/support/transformers-loopback.js';
import {
  createSyntheticModel,
  MemoryCacheStorage,
} from '../../../packages/models/test/support/transformers-model.js';
import readme from '../README.md?raw';
import { createHostCapabilities } from '../src/host/capabilities.js';
import { createOnnxModels, pinnedModelRecord } from '../src/host/models.js';
import { financialAgent } from '../src/recipes/financial/agent.js';
import { financialDefinition } from '../src/recipes/financial/definition.js';
import {
  createFinancialMockModels,
  FINANCIAL_SAMPLE_PROMPT,
} from '../src/recipes/financial/script.js';

afterEach(() => vi.unstubAllGlobals());

test('a missing or invalid record excludes ONNX from default providers without constructing a Worker', async () => {
  const createWorker = vi.fn();
  for (const record of [undefined, null, {}]) {
    const models = createOnnxModels(financialDefinition, record, {
      createWorker,
      confirmDownload: () => false,
    });
    expect(models.routing.providers).toEqual({});
    expect(models.routing.roles).toEqual({});
    expect(models.chatModels).toEqual({});
    await models.dispose();
  }
  expect(createWorker).not.toHaveBeenCalled();
});

// File lengths and digests copied from the reviewed pin output, not derived from the record.
const expectedFiles = [
  ['chat_template.jinja', 7755, '273d8e0e683b885071fb17e08d71e5f2a5ddfb5309756181681de4f5a1822d80'],
  ['config.json', 2849, '36fed6a902ccd06ef19a452bd5a0750bd88fe347d06ab75ef515615bac5b296d'],
  [
    'generation_config.json',
    248,
    'dc0cbe66543f310896469b7b1448af792f403293a1080baaf04d586c57b23e48',
  ],
  [
    'onnx/decoder_model_merged_q4.onnx',
    576621,
    '7390858c80a67275d8cb81fb70f66a24d3b86fe333057c1312de09c184a2d41b',
  ],
  [
    'onnx/decoder_model_merged_q4.onnx_data',
    483655680,
    '1a9165072dd51a9b6a917b6357a3686372b7429313022802cd4c9a730e8c9749',
  ],
  [
    'onnx/embed_tokens_q4.onnx',
    857,
    '8773dcf4858f855bfce13def4356ca17e0bc516a477154496b6ffb6dd6d084dc',
  ],
  [
    'onnx/embed_tokens_q4.onnx_data',
    162897920,
    '9210b1d26eb14136d3522584d17da14cc5f4b82b6f5607e6d80d59424a8cbe99',
  ],
  ['tokenizer.json', 19226111, '89da80cc6689bef4d90cc1028249436975ffb0814618f1d93c65310e05801a9b'],
  [
    'tokenizer_config.json',
    10069,
    '5dcac2c1306b11d1e18ec4c024a174bded2ca3178ce87b0aa590711696407f3d',
  ],
] as const;

test('the committed pin preserves every reviewed field, file length and digest with its documented license', () => {
  const record = parseModelRecord(pinnedModelRecord);
  expect(record).toEqual({
    modelId: 'onnx-community/Qwen3.5-0.8B-ONNX-OPT',
    baseUrl:
      'https://huggingface.co/onnx-community/Qwen3.5-0.8B-ONNX-OPT/resolve/9a4c21d8f724176b0a7edaaed36303044451886e/',
    revision: '9a4c21d8f724176b0a7edaaed36303044451886e',
    device: 'webgpu',
    dtype: 'q4',
    contextWindow: 4096,
    toolFormat: 'xml',
    files: expectedFiles.map(([path, bytes, sha256]) => ({ path, bytes, sha256 })),
  });
  expect(record.files.reduce((sum, file) => sum + file.bytes, 0)).toBe(666378110);
  expect(readme).toMatch(/9a4c21d8f724176b0a7edaaed36303044451886e[^\n]*Apache-2\.0/);
});

async function fixture(options: { cached?: boolean; accept?: boolean; fail?: boolean } = {}) {
  const storage = new MemoryCacheStorage();
  vi.stubGlobal('caches', storage);
  const model = await createSyntheticModel({ toolFormat: 'xml' });
  const { modelCacheName } = await import(
    '../../../packages/models/src/transformers/model-record.js'
  );
  const store = await storage.open(modelCacheName(model.record));
  if (options.cached) await seed(store, model);
  const parts = await setup({
    model,
    store,
    runtime: {
      scripts: [
        [
          '<tool_call><function=market_search_1><parameter=query>Lantern Orchard Workshop</parameter></function></tool_call>',
        ],
        ['Market analysis: synthetic bulletin.'],
        ['Trading strategies: paper study only.'],
        ['Execution plan: no orders.'],
        ['Risk assessment: synthetic evidence only.'],
      ],
      ...(options.fail ? { generateError: new Error('private engine failure') } : {}),
    },
  });
  const createWorker = vi.fn(() => parts.worker);
  const confirmDownload = vi.fn(() => options.accept === true);
  const models = createOnnxModels(financialDefinition, model.record, {
    createWorker,
    confirmDownload,
  });
  return { ...parts, models, createWorker, confirmDownload };
}

async function run(
  models: Awaited<ReturnType<typeof fixture>>['models'],
  fallback?: { downloadable: boolean },
) {
  const mock = createFinancialMockModels();
  const routing: ModelRouting = fallback
    ? {
        providers: { ...models.routing.providers, ...mock.routing.providers },
        roles: Object.fromEntries(
          Object.entries(mock.routing.roles).map(([role, route]) => [
            role,
            { ...route, providers: ['onnx', ...route.providers] },
          ]),
        ),
        availability: async (request) =>
          request.providerId === 'onnx'
            ? ((await models.routing.availability?.(request)) ?? { status: 'unavailable' })
            : fallback.downloadable && !ready.has(request.providerId)
              ? { status: 'downloadable', bytes: 0, siteStorage: false }
              : { status: 'available' },
        download: async (request) => {
          if (request.providerId === 'onnx')
            return (await models.routing.download?.(request)) ?? false;
          ready.add(request.providerId);
          return true;
        },
      }
    : models.routing;
  const ready = new Set<string>();
  const runtime = createRuntime({
    appId: 'recipe-model-test',
    executors: [createAdkAdapter()],
    budgets: { tokens: 20000 },
    outputSafety: () => 'allow',
  });
  try {
    const instance = await runtime.create(financialDefinition, {
      principalScope: 'demo',
      agent: financialAgent,
      models: routing,
      services: { chatModels: { ...models.chatModels, ...(fallback ? mock.chatModels : {}) } },
      bindings: { 'market.search@1': createHostCapabilities('demo').bindings['market.search@1'] },
    });
    await instance.prepare();
    const { runId } = await instance.start({ prompt: FINANCIAL_SAMPLE_PROMPT });
    let output: unknown;
    for await (const event of instance.events(runId))
      if (event.type === 'output') output = event.output;
    return { snapshot: instance.getSnapshot(), output, mock };
  } finally {
    await runtime.dispose();
    await models.dispose();
  }
}

test('a valid record offers ONNX first for every recipe role and a consented fake-runtime run succeeds', async () => {
  const host = await fixture({ accept: true });
  expect(Object.keys(host.models.routing.roles)).toEqual(
    Object.keys(financialDefinition.models ?? {}),
  );
  for (const route of Object.values(host.models.routing.roles))
    expect(route.providers).toEqual(['onnx']);
  expect(host.createWorker).not.toHaveBeenCalled();
  expect(host.fetcher.calls).toEqual([]);
  const result = await run(host.models);
  expect(result.snapshot.run?.status).toBe('succeeded');
  expect(result.output).toBe('Risk assessment: synthetic evidence only.');
  expect(host.confirmDownload).toHaveBeenCalledTimes(1);
  expect(host.fetcher.calls).toEqual(host.model.urls);
  expect(host.runtime.generations).toHaveLength(5);
  expect(host.runtime.generations[0]?.request.tools).toHaveLength(1);
  expect(host.runtime.generations[1]?.request.messages.at(-1)).toMatchObject({ role: 'tool' });
  // A real Qwen run failed `invalid` when each reply could use the default 1024 tokens: the third
  // agent's prompt alone reached 4007 of the 4096-token window. Every request stays well below it.
  for (const generation of host.runtime.generations)
    expect(generation.request.maxTokens).toBeLessThanOrEqual(384);
  for (const route of Object.values(host.models.routing.roles))
    expect(route.maxTokens).toBeLessThanOrEqual(384);
  expect(host.worker.terminated).toBe(1);
});

test('a record without a tool format is omitted for tool-using roles', async () => {
  const model = await createSyntheticModel();
  const createWorker = vi.fn();
  const models = createOnnxModels(financialDefinition, model.record, {
    createWorker,
    confirmDownload: () => false,
  });
  expect(models.routing.roles['financial.data']).toBeUndefined();
  expect(models.routing.roles['financial.risk']?.providers).toEqual(['onnx']);
  expect(models.routing.providers['onnx']?.features).not.toContain('tool-calling');
  expect(createWorker).not.toHaveBeenCalled();
  await models.dispose();
});

test('declining a download falls to the next ordered provider before dispatch and fetches nothing', async () => {
  const host = await fixture();
  const result = await run(host.models, { downloadable: true });
  expect(result.snapshot.run?.status).toBe('succeeded');
  expect(result.snapshot.routes?.['financial.data']?.providerId).toBe('data');
  expect(host.confirmDownload).toHaveBeenCalledTimes(1);
  expect(host.createWorker).not.toHaveBeenCalled();
  expect(host.fetcher.calls).toEqual([]);
  expect(result.mock.chatModels['data']?.calls).toBe(2);
});

test('a cached next in-browser provider is selected before asking for an uncached ONNX download', async () => {
  const host = await fixture({ accept: true });
  const result = await run(host.models, { downloadable: false });
  expect(result.snapshot.run?.status).toBe('succeeded');
  expect(host.confirmDownload).not.toHaveBeenCalled();
  expect(host.createWorker).not.toHaveBeenCalled();
});

test('a failure after ONNX dispatch never invokes the next provider', async () => {
  const host = await fixture({ cached: true, fail: true });
  const result = await run(host.models, { downloadable: false });
  expect(result.snapshot.run).toMatchObject({ status: 'failed', error: { code: 'unavailable' } });
  expect(result.snapshot.routes?.['financial.data']?.providerId).toBe('onnx');
  expect(host.runtime.generations).toHaveLength(1);
  expect(Object.values(result.mock.chatModels).every((model) => model.calls === 0)).toBe(true);
  expect(host.confirmDownload).not.toHaveBeenCalled();
  expect(host.fetcher.calls).toEqual([]);
});

test('missing WebGPU reports unavailable without fetching or asking for download consent', async () => {
  vi.stubGlobal('navigator', {});
  const createWorker = vi.fn();
  const confirmDownload = vi.fn();
  const models = createOnnxModels(financialDefinition, pinnedModelRecord, {
    createWorker,
    confirmDownload,
  });
  const result = await run(models);
  expect(result.snapshot.run).toMatchObject({ status: 'failed', error: { code: 'unavailable' } });
  expect(createWorker).not.toHaveBeenCalled();
  expect(confirmDownload).not.toHaveBeenCalled();
});

test('thinking defaults remain template-owned and emitted think text is ordinary reply text', async () => {
  const record = parseModelRecord(pinnedModelRecord);
  expect(
    templateOptions({ messages: [], maxTokens: 20, temperature: 0 }, record),
  ).not.toHaveProperty('enable_thinking');
  const host = await fixture({ cached: true });
  try {
    const reply = '<think>synthetic reasoning</think>answer';
    const model = host.models.chatModels['onnx'];
    // A fresh fake runtime emits the reasoning markup; there is no provider redaction path.
    const parts = await setup({
      model: host.model,
      store: host.store,
      runtime: { pieces: [reply] },
    });
    const models = createOnnxModels(financialDefinition, host.model.record, {
      createWorker: () => parts.worker,
      confirmDownload: () => false,
    });
    try {
      expect(model).toBeDefined();
      expect((await models.chatModels['onnx']?.invoke('test'))?.content).toBe(reply);
    } finally {
      await models.dispose();
    }
  } finally {
    await host.models.dispose();
  }
});
