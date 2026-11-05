// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import {
  createRuntime,
  type DiagnosticEvent,
  galaxieField,
  type ModelRouting,
  type RunRequest,
} from '../src/index.js';
import { binding, collect, definition, FakeExecutor } from './fake-executor.js';

const models: ModelRouting = {
  providers: {
    remote: {
      destination: 'third-party',
      modality: 'text',
      features: [],
      pricing: { inputPerToken: 0, outputPerToken: 0 },
    },
    local: {
      destination: 'in-browser',
      modality: 'text',
      features: [],
      pricing: { inputPerToken: 0, outputPerToken: 0 },
    },
  },
  roles: {
    assistant: {
      providers: ['remote', 'local'],
      allow: ['third-party', 'in-browser'],
      maxTokens: 1000,
    },
  },
  consent: () => true,
};
const modelDefinition = {
  ...definition,
  input: z.string().meta(galaxieField({ label: 'public' })),
  models: { assistant: { modality: 'text' as const } },
};

test('declared model roles require routing at create before prepare', async () => {
  const executor = new FakeExecutor();
  const runtime = createRuntime({ appId: 'test', executors: [executor] });
  await expect(
    runtime.create(modelDefinition, { principalScope: 'user', agent: {} }),
  ).rejects.toMatchObject({ code: 'invalid' });
  expect(executor.prepareCalls).toBe(0);
  await runtime.dispose();
});

test('routes publish only on first dispatch and changes, and prepare receives provider requirements', async () => {
  const executor = new FakeExecutor([
    async function* (request) {
      (await request.models.begin('assistant')).end({ inputTokens: 1, outputTokens: 1 });
      (await request.models.begin('assistant')).end({ inputTokens: 1, outputTokens: 1 });
      await request.capabilities.call('private@1', null);
      (await request.models.begin('assistant')).end({ inputTokens: 1, outputTokens: 1 });
      yield { type: 'output', output: null };
    },
  ]);
  const prepare = vi.spyOn(executor, 'prepare');
  const runtime = createRuntime({ appId: 'test', executors: [executor] });
  const instance = await runtime.create(
    {
      ...modelDefinition,
      capabilities: {
        required: {
          'private@1': {
            input: z.null(),
            output: z.string().meta(galaxieField({ label: 'private-user' })),
            kind: 'read',
          },
        },
      },
    },
    {
      principalScope: 'user',
      agent: {},
      models,
      bindings: { 'private@1': { ...binding(), invoke: async () => 'private sentence' } },
    },
  );
  expect(instance.getSnapshot().routes).toBeUndefined();
  const notices: unknown[] = [];
  let previous = instance.getSnapshot().routes;
  instance.subscribe(() => {
    const routes = instance.getSnapshot().routes;
    if (routes !== previous) {
      notices.push(routes);
      previous = routes;
    }
  });
  await instance.prepare();
  expect(prepare).toHaveBeenCalledWith(
    {},
    undefined,
    expect.objectContaining({
      models: {
        roles: ['assistant'],
        providers: { remote: { credential: false }, local: { credential: false } },
      },
    }),
  );
  const { runId } = await instance.start('input');
  expect((await collect(instance.events(runId))).at(-1)?.type).toBe('output');
  await runtime.dispose();
  expect(notices).toEqual([
    { assistant: { providerId: 'remote', destination: 'third-party' } },
    { assistant: { providerId: 'local', destination: 'in-browser', changedFrom: 'third-party' } },
  ]);
  expect(instance.getSnapshot().routes).toEqual(notices[1]);
  expect(Object.isFrozen(instance.getSnapshot().routes)).toBe(true);
});

test('AE4 model reservation failure closes the root with its budget before the executor late error', async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  let dispatched = 0;
  const executor = new FakeExecutor([
    async function* ({ models }) {
      (await models.begin('assistant')).end();
      dispatched++;
      try {
        await models.begin('assistant');
        dispatched++;
      } catch {
        yield { type: 'error', error: { code: 'executor_error', message: 'late' } };
      }
    },
  ]);
  const diagnostics: DiagnosticEvent[] = [];
  const runtime = createRuntime({
    appId: 'test',
    executors: [executor],
    budgets: { tokens: 1500 },
    tracerProvider: provider,
    diagnostics: (event) => diagnostics.push(event),
  });
  const instance = await runtime.create(modelDefinition, {
    principalScope: 'user',
    agent: {},
    models,
  });
  await instance.prepare();
  const { runId } = await instance.start('input');
  const events = await collect(instance.events(runId));
  await runtime.dispose();
  expect(dispatched).toBe(1);
  expect(events).toMatchObject([{ type: 'error', error: { code: 'budget_exceeded' } }]);
  expect(instance.getSnapshot().run).toMatchObject({
    status: 'failed',
    error: { code: 'budget_exceeded' },
  });
  expect(exporter.getFinishedSpans()[0]?.attributes).toMatchObject({
    'galaxie.budget.name': 'tokens',
    'galaxie.error.code': 'budget_exceeded',
  });
  expect(diagnostics.some((event) => event.kind === 'late_event')).toBe(true);
  await provider.shutdown();
});

test('provider changes within one class publish no class-change notice', async () => {
  let first = true;
  const executor = new FakeExecutor([
    async function* ({ models }) {
      (await models.begin('assistant')).end({ inputTokens: 1, outputTokens: 1 });
      first = false;
      (await models.begin('assistant')).end({ inputTokens: 1, outputTokens: 1 });
      yield { type: 'output', output: null };
    },
  ]);
  const runtime = createRuntime({ appId: 'test', executors: [executor] });
  try {
    const instance = await runtime.create(modelDefinition, {
      principalScope: 'user',
      agent: {},
      models: {
        providers: {
          first: {
            destination: 'in-browser',
            modality: 'text',
            features: [],
            pricing: { inputPerToken: 0, outputPerToken: 0 },
          },
          second: {
            destination: 'in-browser',
            modality: 'text',
            features: [],
            pricing: { inputPerToken: 0, outputPerToken: 0 },
          },
        },
        roles: {
          assistant: { providers: ['first', 'second'], allow: ['in-browser'], maxTokens: 1000 },
        },
        availability: ({ providerId }) => ({
          status: providerId === 'first' && !first ? 'unavailable' : 'available',
        }),
      },
    });
    await instance.prepare();
    const { runId } = await instance.start('input');
    await collect(instance.events(runId));
    expect(instance.getSnapshot().routes).toEqual({
      assistant: { providerId: 'second', destination: 'in-browser' },
    });
  } finally {
    await runtime.dispose();
  }
});

test('class-change notices compare the previous run of the same instance', async () => {
  let first = true;
  const call = async function* ({ models }: RunRequest) {
    (await models.begin('assistant')).end({ inputTokens: 1, outputTokens: 1 });
    yield { type: 'output' as const, output: null };
  };
  const executor = new FakeExecutor([call, call]);
  const runtime = createRuntime({ appId: 'test', executors: [executor] });
  try {
    const instance = await runtime.create(modelDefinition, {
      principalScope: 'user',
      agent: {},
      models: {
        ...models,
        availability: ({ providerId }) => ({
          status: providerId === 'remote' && !first ? 'unavailable' : 'available',
        }),
      },
    });
    await instance.prepare();
    const initial = await instance.start('input');
    await collect(instance.events(initial.runId));
    expect(instance.getSnapshot().routes).toEqual({
      assistant: { providerId: 'remote', destination: 'third-party' },
    });
    first = false;
    const later = await instance.start('input');
    await collect(instance.events(later.runId));
    expect(instance.getSnapshot().routes).toEqual({
      assistant: { providerId: 'local', destination: 'in-browser', changedFrom: 'third-party' },
    });
  } finally {
    await runtime.dispose();
  }
});
