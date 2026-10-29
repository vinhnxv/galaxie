// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import {
  type AgentDefinition,
  createRuntime,
  type DevelopmentWarning,
  type DiagnosticEvent,
  type ModelAvailability,
  type ModelAvailabilityRequest,
  type ModelDescriptor,
  type ModelRoleRequirements,
  type ModelRouting,
} from '../src/index.js';
import { binding, collect, deferred, definition, FakeExecutor, flush } from './fake-executor.js';

const runtimes: Array<{ dispose(): Promise<void> }> = [];
const local: ModelDescriptor = {
  destination: 'in-browser',
  modality: 'text',
  features: ['streaming'],
  languages: ['en-US'],
  pricing: { inputPerToken: 0, outputPerToken: 0 },
};
const request = { kind: 'read', input: z.string(), output: z.string() } as const;

function fixture(enabled = true, callback?: (warning: DevelopmentWarning) => void) {
  const warnings: DevelopmentWarning[] = [];
  const diagnostics: DiagnosticEvent[] = [];
  const executor = new FakeExecutor();
  const runtime = createRuntime({
    appId: 'development-tests',
    executors: [executor],
    diagnostics: (event) => diagnostics.push(event),
    outputSafety: () => 'allow',
    ...(enabled ? { developmentWarnings: callback ?? ((warning) => warnings.push(warning)) } : {}),
  });
  runtimes.push(runtime);
  return { runtime, executor, warnings, diagnostics };
}

function routing(overrides: Partial<ModelRouting> = {}): ModelRouting {
  return {
    providers: { local },
    roles: { assistant: { providers: ['local'], allow: ['in-browser'], maxTokens: 10 } },
    ...overrides,
  };
}

const modelDefinition: AgentDefinition = {
  ...definition,
  models: { assistant: { modality: 'text', requires: ['streaming'], languages: ['en-GB'] } },
};

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('only optional unbound capabilities warn, with instance identity', async () => {
  const { runtime, warnings } = fixture();
  const instance = await runtime.create(
    { ...definition, capabilities: { optional: { 'missing@1': request, 'bound@1': request } } },
    {
      agent: {},
      principalScope: 'test',
      bindings: { 'bound@1': { ...binding(), invoke: async (input: string) => input } },
    },
  );
  expect(instance.getSnapshot().state).toBe('created');
  expect(warnings).toEqual([
    { code: 'capability_unbound', instanceId: instance.instanceId, name: 'missing@1' },
  ]);
  await instance.prepare();
  const { runId } = await instance.start('input');
  await collect(instance.events(runId));
  expect(warnings).toHaveLength(1);
});

test.each(['required', 'unrequested'] as const)(
  '%s binding errors emit no warning',
  async (kind) => {
    const { runtime, warnings } = fixture();
    await expect(
      runtime.create(
        {
          ...definition,
          capabilities: {
            optional: { 'optional@1': request },
            ...(kind === 'required' ? { required: { 'required@1': request } } : {}),
          },
        } as AgentDefinition,
        {
          agent: {},
          principalScope: 'test',
          bindings: kind === 'required' ? {} : { 'extra@1': binding() },
        },
      ),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(warnings).toEqual([]);
  },
);

test.each(['missing', 'empty', 'unknown'] as const)(
  'invalid %s route emits no warning',
  async (kind) => {
    const { runtime, warnings } = fixture();
    await expect(
      runtime.create(modelDefinition, {
        agent: {},
        principalScope: 'test',
        models: routing({
          roles:
            kind === 'missing'
              ? {}
              : {
                  assistant: {
                    providers: kind === 'empty' ? [] : ['unknown'],
                    allow: ['in-browser'],
                    maxTokens: 10,
                  },
                },
        }),
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(warnings).toEqual([]);
  },
);

test.each([
  { requires: ['streaming'], languages: ['EN-gb'], usable: true },
  { requires: ['structured-output'], usable: false },
  { languages: ['vi'], usable: false },
] satisfies Array<Partial<ModelRoleRequirements> & { usable: boolean }>)(
  'role descriptor matching: %j',
  async ({ usable, ...requirements }) => {
    const { runtime, warnings } = fixture();
    const instance = await runtime.create(
      { ...definition, models: { assistant: { modality: 'text', ...requirements } } },
      { agent: {}, principalScope: 'test', models: routing() },
    );
    expect(warnings).toEqual(
      usable
        ? []
        : [{ code: 'role_without_provider', instanceId: instance.instanceId, name: 'assistant' }],
    );
  },
);

test.each([
  { status: 'available', destination: 'in-browser', download: false, usable: true },
  { status: 'unavailable', destination: 'in-browser', download: true, usable: false },
  { status: 'downloadable', destination: 'in-browser', download: true, usable: true },
  { status: 'downloadable', destination: 'in-browser', download: false, usable: false },
  { status: 'downloadable', destination: 'third-party', download: true, usable: false },
] as const)('availability check: %j', async ({ status, destination, download, usable }) => {
  const { runtime, warnings, diagnostics } = fixture();
  const availability = vi.fn(() =>
    status === 'downloadable' ? { status, siteStorage: false } : { status },
  );
  const downloadHook = vi.fn(() => true);
  const instance = await runtime.create(modelDefinition, {
    agent: {},
    principalScope: 'test',
    models: routing({
      providers: { local: { ...local, destination } },
      roles: { assistant: { providers: ['local'], allow: [destination], maxTokens: 10 } },
      availability,
      ...(download ? { download: downloadHook } : {}),
    }),
  });
  expect(availability).toHaveBeenCalledExactlyOnceWith({
    role: 'assistant',
    providerId: 'local',
    signal: expect.any(AbortSignal),
  });
  expect(warnings).toEqual(
    usable
      ? []
      : [{ code: 'role_without_provider', instanceId: instance.instanceId, name: 'assistant' }],
  );
  expect(downloadHook).not.toHaveBeenCalled();
  expect(diagnostics).toEqual([]);
});

test.each(['throw', 'reject', 'null', 'unknown', 'bytes', 'siteStorage'] as const)(
  'probe failure %s is unavailable without diagnostics',
  async (kind) => {
    const { runtime, warnings, diagnostics } = fixture();
    const availability = () => {
      if (kind === 'throw') throw new Error('host-only failure');
      if (kind === 'reject') return Promise.reject(new Error('host-only failure'));
      if (kind === 'null') return null;
      return kind === 'unknown'
        ? { status: 'other' }
        : {
            status: 'downloadable',
            siteStorage: kind === 'siteStorage' ? undefined : true,
            bytes: -1,
          };
    };
    await runtime.create(modelDefinition, {
      agent: {},
      principalScope: 'test',
      models: routing({
        availability: availability as NonNullable<ModelRouting['availability']>,
        download: () => true,
      }),
    });
    expect(warnings.map(({ code }) => code)).toEqual(['role_without_provider']);
    expect(diagnostics).toEqual([]);
  },
);

test('create awaits every provider once per role, including mismatched and duplicate entries', async () => {
  const { runtime, warnings } = fixture();
  const answer = deferred<ModelAvailability>();
  const availability = vi.fn(() => answer.promise);
  const creating = runtime.create(modelDefinition, {
    agent: {},
    principalScope: 'test',
    models: routing({
      providers: { local, other: { ...local, features: [] } },
      roles: {
        assistant: { providers: ['local', 'local', 'other'], allow: ['in-browser'], maxTokens: 10 },
      },
      availability,
    }),
  });
  let created = false;
  void creating.then(() => {
    created = true;
  });
  await flush();
  expect(created).toBe(false);
  answer.resolve({ status: 'available' });
  const instance = await creating;
  expect(availability.mock.calls).toHaveLength(2);
  expect(warnings).toEqual([]);
  await instance.dispose();
});

test('runtime disposal aborts creation probes that ignore cancellation', async () => {
  const { runtime, warnings, diagnostics } = fixture();
  const requests: ModelAvailabilityRequest[] = [];
  const answer = deferred<ModelAvailability>();
  const creating = runtime.create(modelDefinition, {
    agent: {},
    principalScope: 'test',
    models: routing({
      availability: (request) => {
        requests.push(request);
        return answer.promise;
      },
    }),
  });
  await flush();
  expect(requests).toHaveLength(1);
  await runtime.dispose();
  expect(requests[0]?.signal.aborted).toBe(true);
  await expect(creating).rejects.toMatchObject({ code: 'cancelled' });
  answer.resolve({ status: 'unavailable' });
  await flush();
  expect(warnings).toEqual([]);
  expect(diagnostics).toEqual([]);
});

test('throwing instance callbacks report listener_threw without affecting the run', async () => {
  const error = new Error('host-only warning listener');
  const callback = vi.fn(() => {
    throw error;
  });
  const { runtime, diagnostics } = fixture(true, callback);
  const instance = await runtime.create(
    { ...definition, capabilities: { optional: { 'missing@1': request } } },
    { agent: {}, principalScope: 'test' },
  );
  await instance.prepare();
  const { runId } = await instance.start('input');
  await collect(instance.events(runId));
  expect(instance.getSnapshot().run?.status).toBe('succeeded');
  expect(callback).toHaveBeenCalledTimes(1);
  expect(diagnostics).toEqual([{ kind: 'listener_threw', instanceId: instance.instanceId, error }]);
});

test('warnings from one instance do not suppress another instance', async () => {
  const { runtime, warnings } = fixture();
  const agent = { ...definition, capabilities: { optional: { 'missing@1': request } } };
  const first = await runtime.create(agent, { agent: {}, principalScope: 'test' });
  const second = await runtime.create(agent, { agent: {}, principalScope: 'test' });
  expect(warnings.map(({ instanceId }) => instanceId)).toEqual([
    first.instanceId,
    second.instanceId,
  ]);
});

test('absent option performs no creation availability check', async () => {
  const { runtime, warnings } = fixture(false);
  const availability = vi.fn(() => ({ status: 'unavailable' as const }));
  await runtime.create(modelDefinition, {
    agent: {},
    principalScope: 'test',
    models: routing({ availability }),
  });
  expect(availability).not.toHaveBeenCalled();
  expect(warnings).toEqual([]);
});
