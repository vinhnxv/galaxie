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
  type PendingInteraction,
  type UiBindings,
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

function storage(values: readonly string[]): Storage {
  return {
    length: values.length,
    key: vi.fn((index: number) => String(index)),
    getItem: vi.fn((key: string) => values[Number(key)] ?? null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
  };
}

function page(): void {
  vi.stubGlobal('document', { createElement: () => ({ innerHTML: '' }) });
  vi.stubGlobal('localStorage', storage([]));
  vi.stubGlobal('sessionStorage', storage([]));
}

test.each(
  [
    `sk-${'x'.repeat(20)}`,
    `sk-ant-${'x'.repeat(20)}`,
    `sk-proj-${'x'.repeat(20)}`,
    `AIza${'x'.repeat(35)}`,
    `gsk_${'x'.repeat(20)}`,
    `hf_${'x'.repeat(20)}`,
    `xai-${'x'.repeat(20)}`,
    `r8_${'x'.repeat(20)}`,
  ].flatMap((value) => [value, JSON.stringify({ credential: value })]),
)('synthetic storage value pattern %s emits only its area', (value) => {
  page();
  const area = storage([value, value]);
  vi.stubGlobal('localStorage', area);
  const { warnings } = fixture();
  expect(warnings.filter(({ code }) => code === 'provider_key_in_storage')).toEqual([
    { code: 'provider_key_in_storage', area: 'localStorage' },
  ]);
  expect(JSON.stringify(warnings)).not.toContain(value);
  expect(area.setItem).not.toHaveBeenCalled();
  expect(area.removeItem).not.toHaveBeenCalled();
  expect(area.clear).not.toHaveBeenCalled();
});

test('storage matching requires a token boundary and ignores short and unrelated values', () => {
  page();
  const prefixes = ['sk-', 'sk-ant-', 'sk-proj-', 'AIza', 'gsk_', 'hf_', 'xai-', 'r8_'];
  vi.stubGlobal(
    'localStorage',
    storage([
      `task-${'x'.repeat(20)}`,
      'half_value',
      `sk-${'x'.repeat(19)}`,
      ...prefixes.flatMap((prefix) =>
        ['a', '9', '_', '-'].map((boundary) => `${boundary}${prefix}${'x'.repeat(35)}`),
      ),
    ]),
  );
  const { warnings } = fixture();
  expect(warnings.filter(({ code }) => code === 'provider_key_in_storage')).toEqual([]);
});

test('both storage areas warn once without names or values', async () => {
  page();
  for (const area of ['localStorage', 'sessionStorage'])
    vi.stubGlobal(area, storage([`sk-${'x'.repeat(20)}`]));
  const { runtime, warnings } = fixture();
  for (let index = 0; index < 2; index++)
    await runtime.create(definition, { agent: {}, principalScope: 'test' });
  expect(warnings.filter(({ code }) => code === 'provider_key_in_storage')).toEqual([
    { code: 'provider_key_in_storage', area: 'localStorage' },
    { code: 'provider_key_in_storage', area: 'sessionStorage' },
  ]);
});

test.each(['access', 'key', 'getItem'] as const)(
  'storage %s failure is skipped independently',
  (kind) => {
    page();
    const area = storage(['plain']);
    const fail = (): never => {
      throw new Error('host-only storage failure');
    };
    if (kind === 'access')
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: fail });
    else vi.spyOn(area, kind).mockImplementation(fail);
    if (kind !== 'access') vi.stubGlobal('localStorage', area);
    vi.stubGlobal('sessionStorage', storage([`sk-${'x'.repeat(20)}`]));
    const { warnings, diagnostics } = fixture();
    expect(warnings.filter(({ code }) => code === 'provider_key_in_storage')).toEqual([
      { code: 'provider_key_in_storage', area: 'sessionStorage' },
    ]);
    expect(diagnostics).toEqual([]);
  },
);

test('page probes warn once per runtime and contain only constant identifiers', async () => {
  page();
  const createElement = vi.spyOn(document, 'createElement');
  const { runtime, warnings } = fixture();
  await runtime.create(definition, { agent: {}, principalScope: 'test' });
  await runtime.create(definition, { agent: {}, principalScope: 'test' });
  expect(warnings).toEqual([
    { code: 'trusted_types_unenforced' },
    { code: 'csp_unenforced', name: 'script-src' },
  ]);
  expect(createElement).toHaveBeenCalledExactlyOnceWith('template');
});

test('blocked or failed page probes emit nothing', () => {
  page();
  vi.spyOn(document, 'createElement').mockImplementation(() => {
    throw new TypeError('blocked');
  });
  vi.spyOn(globalThis, 'Function').mockImplementation(() => {
    throw new TypeError('blocked');
  });
  const { warnings, diagnostics } = fixture();
  expect(warnings).toEqual([]);
  expect(diagnostics).toEqual([]);
});

test('runtime-level callback errors are queued without becoming diagnostics', () => {
  page();
  const error = new Error('host-only callback failure');
  const queued: VoidFunction[] = [];
  vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((callback) => queued.push(callback));
  const { diagnostics } = fixture(true, () => {
    throw error;
  });
  expect(queued).toHaveLength(2);
  for (const callback of queued) expect(callback).toThrow(error);
  expect(diagnostics).toEqual([]);
});

test.each([true, false])('page checks are skipped without a page, enabled %s', (enabled) => {
  vi.stubGlobal('document', undefined);
  const getItem = vi.fn();
  vi.stubGlobal('localStorage', { length: 1, key: () => 'test', getItem });
  const { warnings } = fixture(enabled);
  expect(getItem).not.toHaveBeenCalled();
  expect(warnings).toEqual([]);
});

test('absent option reads neither storage nor document and never probes providers', async () => {
  page();
  const reads = vi.fn(() => storage([`sk-${'x'.repeat(20)}`]));
  for (const area of ['localStorage', 'sessionStorage'])
    Object.defineProperty(globalThis, area, { configurable: true, get: reads });
  const createElement = vi.spyOn(document, 'createElement');
  const functionProbe = vi.spyOn(globalThis, 'Function');
  const availability = vi.fn(() => ({ status: 'available' as const }));
  const { runtime, warnings } = fixture(false);
  const instance = await runtime.create(modelDefinition, {
    agent: {},
    principalScope: 'test',
    models: routing({ availability }),
  });
  await instance.prepare();
  const { runId } = await instance.start('input');
  await collect(instance.events(runId));
  expect(reads).not.toHaveBeenCalled();
  expect(createElement).not.toHaveBeenCalled();
  expect(functionProbe).not.toHaveBeenCalled();
  expect(availability).not.toHaveBeenCalled();
  expect(warnings).toEqual([]);
});

const pending: PendingInteraction = {
  interactionId: 'warning' as PendingInteraction['interactionId'],
  component: 'tests.Question/v1',
  surfaceId: 'main',
  viewRevision: 'v1' as PendingInteraction['viewRevision'],
  props: { image: 'https://blocked.example/synthetic-path' },
};
const ui: UiBindings = { components: { 'tests.Question/v1': { actions: {} } }, surfaces: ['main'] };

test.each(['absent', 'bound', 'unbound'] as const)(
  'URL warnings identify only a host-bound component: %s',
  async (kind) => {
    const { runtime, executor, warnings, diagnostics } = fixture();
    executor.scripts.push(
      [{ type: 'interaction', interaction: pending }],
      [{ type: 'interaction', interaction: pending }],
    );
    const instance = await runtime.create(definition, {
      agent: {},
      principalScope: 'test',
      ...(kind === 'absent' ? {} : { ui: kind === 'bound' ? ui : { ...ui, components: {} } }),
    });
    await instance.prepare();
    for (let index = 0; index < 2; index++) {
      const { runId } = await instance.start('input');
      await collect(instance.events(runId));
      expect(instance.getSnapshot().run).toMatchObject({
        status: 'failed',
        error: { code: 'denied' },
      });
    }
    expect(warnings).toEqual([
      {
        code: 'url_blocked',
        instanceId: instance.instanceId,
        ...(kind === 'bound' ? { name: pending.component } : {}),
      },
    ]);
    expect(diagnostics.map(({ kind }) => kind)).toEqual([
      'interaction_rejected',
      'interaction_rejected',
    ]);
  },
);

test('restore emits a de-duplicated URL warning before exposing pending props', async () => {
  const { runtime, executor, warnings } = fixture();
  Object.assign(executor.features, { checkpoints: true, resume: true });
  executor.agent.pending = async () => pending;
  const instance = await runtime.create(definition, { agent: {}, principalScope: 'test', ui });
  await instance.prepare();
  for (let index = 0; index < 2; index++)
    await expect(instance.restore()).rejects.toMatchObject({ code: 'denied' });
  expect(warnings).toEqual([
    { code: 'url_blocked', instanceId: instance.instanceId, name: pending.component },
  ]);
  expect(instance.getSnapshot().run?.pending).toBeUndefined();
});

test('binding rejection without a URL emits no warning', async () => {
  const { runtime, executor, warnings } = fixture();
  executor.scripts.push([{ type: 'interaction', interaction: { ...pending, props: {} } }]);
  const instance = await runtime.create(definition, {
    agent: {},
    principalScope: 'test',
    ui: { ...ui, components: {} },
  });
  await instance.prepare();
  const { runId } = await instance.start('input');
  await collect(instance.events(runId));
  expect(instance.getSnapshot().run?.error?.code).toBe('unsupported');
  expect(warnings).toEqual([]);
});
