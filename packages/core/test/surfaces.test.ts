// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  A2UI_SPEC_REVISION,
  A2UI_SPEC_VERSION,
  type Catalog,
  type MaterializedSurface,
  type SyncSchema,
  validateSurface,
} from '@galaxie/ui-protocol';
import { trace } from '@opentelemetry/api';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { createAgentInstance } from '../src/agent-instance.js';
import {
  type BudgetLimits,
  createRuntime,
  type DiagnosticEvent,
  type InteractionId,
  type InteractionRequest,
  materializeSurface,
  type PendingInteraction,
  parseSurfaceRecord,
  pendingFromSurface,
  type UiBindings,
  type UserInteractionEvent,
} from '../src/index.js';
import { normalizeUiBindings } from '../src/interactions.js';
import { DEFAULT_BUDGETS, DEFAULT_DATA_POLICY } from '../src/policy.js';
import * as privatePolicy from '../src/private-values.js';
import {
  checkSurfaceUrls,
  createSurfacePolicy,
  surfaceFromRequest,
  surfaceModelChanges,
} from '../src/surfaces.js';
import { collect, deferred, definition, FakeExecutor, flush } from './fake-executor.js';
import { MemoryRecoveryStore } from './support/memory-recovery-store.js';

function sync(schema: z.ZodType): SyncSchema {
  return {
    '~standard': {
      version: 1,
      vendor: 'surface-test',
      validate(value: unknown) {
        const result = schema.safeParse(value);
        return result.success ? { value: result.data } : { issues: [] };
      },
    },
  };
}

const catalog: Catalog = {
  id: 'education/v1',
  components: {
    Quiz: {
      bindable: ['answer'],
      urls: ['url'],
      children: ['children'],
      props: sync(
        z
          .object({
            answer: z.string(),
            url: z.string().optional(),
            children: z.array(z.string()).optional(),
          })
          .strict(),
      ),
    },
    Text: { props: sync(z.object({ text: z.string() }).strict()) },
  },
};
const ui: UiBindings = {
  catalogs: { [catalog.id]: catalog },
  surfaces: ['main'],
  components: {
    'education.Quiz/v1': {
      actions: { submit: { payload: z.object({ answers: z.array(z.string()) }).strict() } },
    },
    'education.Text/v1': { actions: { continue: { payload: z.object({}).strict() } } },
  },
};
const context = {
  binding: { region: 'main', a2uiSurfaceId: 'lesson', catalogId: catalog.id },
  catalog,
  limits: { payloadBytes: 1_048_576, components: 50 },
  isAllowedUrl: () => true,
};
function record(overrides: Partial<MaterializedSurface> = {}): MaterializedSurface {
  return {
    format: 'galaxie.surface/1',
    ...context.binding,
    revision: 1,
    specVersion: A2UI_SPEC_VERSION,
    specRevision: A2UI_SPEC_REVISION,
    status: 'live',
    components: {
      root: { id: 'root', component: 'Quiz', answer: { '@path': '/answer' }, children: ['text'] },
      text: { id: 'text', component: 'Text', text: 'Continue' },
    },
    dataModel: { answer: '', fixed: 'unchanged' },
    ...overrides,
  };
}
function pending(value = record(), id = 'ask'): PendingInteraction {
  return pendingFromSurface(id as InteractionId, value);
}
const disposables: Array<{ dispose(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(disposables.splice(0).map((item) => item.dispose()));
  vi.restoreAllMocks();
});

async function fixture(
  values = [record()],
  bindings: UiBindings | undefined = ui,
  store?: MemoryRecoveryStore,
  budgets?: Partial<BudgetLimits>,
) {
  const pendings = values.map((value, index) => pending(value, `ask-${index}`));
  const executor = new FakeExecutor([
    ...pendings.map((interaction) => [{ type: 'interaction' as const, interaction }]),
    [{ type: 'output', output: null }],
  ]);
  Object.assign(executor.features, { resume: true, checkpoints: true });
  executor.agent.pending = async () => pendings[Math.max(0, executor.requests.length - 1)];
  const diagnostics: DiagnosticEvent[] = [];
  const runtime = createRuntime({
    appId: 'surfaces',
    executors: [executor],
    urlAllowlist: ['https://example.test'],
    diagnostics: (event) => diagnostics.push(event),
    ...(budgets === undefined ? {} : { budgets }),
  });
  disposables.push(runtime);
  const instance = await runtime.create(definition, {
    principalScope: 'user',
    agent: {},
    ...(bindings === undefined ? {} : { ui: bindings }),
    ...(store === undefined ? {} : { recovery: store }),
  });
  await instance.prepare();
  const { runId } = await instance.start('input');
  await flush();
  const first = pendings[0];
  if (first === undefined) throw new Error('The test interaction is missing.');
  const event: UserInteractionEvent = {
    instanceId: instance.instanceId,
    runId,
    interactionId: first.interactionId,
    surfaceId: first.surfaceId,
    viewRevision: first.viewRevision,
    action: 'submit',
    payload: { answers: ['yes'] },
    surfaceAction: {
      revision: values[0]?.revision ?? 1,
      componentId: 'root',
      dataModel: record().dataModel,
    },
  };
  return { runtime, instance, executor, diagnostics, event };
}

test('materializes pinned records, freezes the detached projection and preserves legacy domain props', () => {
  const value = materializeSurface({
    ...context,
    messages: [
      {
        version: '1.0',
        createSurface: {
          surfaceId: 'lesson',
          components: [{ id: 'root', component: 'Quiz', answer: 'yes' }],
        },
      },
    ],
  });
  expect(value).toMatchObject({
    revision: 1,
    specVersion: A2UI_SPEC_VERSION,
    specRevision: A2UI_SPEC_REVISION,
  });
  const projected = pending(value);
  expect(projected).toMatchObject({
    component: 'education.Quiz/v1',
    props: { answer: 'yes' },
    viewRevision: 'lesson#1',
  });
  expect(Object.isFrozen(projected.surface?.components['root'])).toBe(true);
  expect(projected.surface).not.toBe(value);
  expect(parseSurfaceRecord({ ...value, labels: ['public'] })).toBeUndefined();
  expect(parseSurfaceRecord({ ...value, dataModel: { value: new Date() } })).toBeUndefined();
  expect(() => materializeSurface({ ...context, messages: [] })).toThrow('The request is invalid.');
});

test('maps a tutor-style legacy Quiz without changing its request', () => {
  const request: InteractionRequest = {
    surfaceId: 'main',
    viewRevision: 'legacy' as InteractionRequest['viewRevision'],
    component: 'education.Quiz/v1',
    props: { questions: [{ id: 'one', prompt: 'Choose' }] },
  };
  expect(surfaceFromRequest(request, catalog.id)).toMatchObject({
    revision: 1,
    dataModel: {},
    components: { root: { id: 'root', component: 'Quiz', ...request.props } },
  });
  expect(
    surfaceFromRequest({ ...request, props: { id: 'collision' } }, catalog.id),
  ).toBeUndefined();
  expect(
    surfaceFromRequest({ ...request, props: { component: 'collision' } }, catalog.id),
  ).toBeUndefined();
  expect(surfaceFromRequest(request, 'other/v1')).toBeUndefined();
  expect(request.viewRevision).toBe('legacy');
});

test('catalog normalization detaches and freezes the binding table and rejects mismatched identities', () => {
  const normalized = normalizeUiBindings(ui);
  expect(normalized.catalogs).not.toBe(ui.catalogs);
  expect(Object.isFrozen(normalized.catalogs)).toBe(true);
  expect(Object.isFrozen(normalized.catalogs?.[catalog.id])).toBe(true);
  expect(() => normalizeUiBindings({ ...ui, catalogs: { other: catalog } })).toThrow(
    'The UI bindings are invalid.',
  );
});

test.each([
  { surfaceAction: undefined },
  { surfaceAction: null },
  { surfaceAction: {} },
  { surfaceAction: { revision: '1', componentId: 'root', dataModel: {} } },
  { surfaceAction: { revision: 1, componentId: 'root', dataModel: [] } },
  { surfaceAction: { revision: 1, componentId: 'absent', dataModel: record().dataModel } },
  {
    surfaceAction: {
      revision: 1,
      componentId: 'root',
      dataModel: { answer: '', fixed: 'changed' },
    },
  },
])('rejects a missing or malformed surface submission without resuming: %j', async (override) => {
  const f = await fixture();
  expect(
    await f.instance.dispatch({ ...f.event, ...override } as unknown as UserInteractionEvent),
  ).toMatchObject({ status: 'rejected', error: { code: 'invalid' } });
  expect(f.executor.requests).toHaveLength(1);
});

test('checks numeric and view revisions, committed identity, actions and duplicate precedence', async () => {
  const f = await fixture();
  expect(
    await f.instance.dispatch({
      ...f.event,
      surfaceAction: {
        ...(f.event.surfaceAction as NonNullable<UserInteractionEvent['surfaceAction']>),
        revision: 2,
      },
    }),
  ).toMatchObject({ error: { code: 'stale' } });
  expect(
    await f.instance.dispatch({
      ...f.event,
      viewRevision: 'wrong' as UserInteractionEvent['viewRevision'],
    }),
  ).toMatchObject({ error: { code: 'stale' } });
  const original = f.executor.agent.pending;
  f.executor.agent.pending = async () => pending(record({ revision: 2 }), 'ask-0');
  expect(await f.instance.dispatch(f.event)).toMatchObject({ error: { code: 'stale' } });
  f.executor.agent.pending = original;
  expect(await f.instance.dispatch({ ...f.event, action: 'continue' })).toMatchObject({
    error: { code: 'invalid' },
  });
  expect(await f.instance.dispatch(f.event)).toMatchObject({ status: 'accepted' });
  expect(
    await f.instance.dispatch({
      ...f.event,
      surfaceAction: undefined,
    } as unknown as UserInteractionEvent),
  ).toMatchObject({ error: { code: 'duplicate' } });
  await collect(f.instance.events(f.event.runId));
  expect(f.executor.requests[1]?.command).toEqual({
    type: 'resume',
    interactionId: f.event.interactionId,
    action: 'submit',
    payload: { answers: ['yes'] },
  });
});

test('validates actions on the originating child component', async () => {
  const f = await fixture();
  expect(
    await f.instance.dispatch({
      ...f.event,
      action: 'continue',
      payload: {},
      surfaceAction: { revision: 1, componentId: 'text', dataModel: record().dataModel },
    }),
  ).toMatchObject({ status: 'accepted' });
});

test.each([undefined, { ...ui, catalogs: {} }, { ...ui, surfaces: ['elsewhere'] }])(
  'fails closed without a catalog or region binding',
  async (bindings) => {
    const f = await fixture([record()], bindings);
    // An explicit absent UI must bypass the fixture default.
    if (bindings === undefined) {
      const executor = new FakeExecutor([[{ type: 'interaction', interaction: pending() }]]);
      const runtime = createRuntime({ appId: 'no-ui', executors: [executor] });
      disposables.push(runtime);
      const instance = await runtime.create(definition, { principalScope: 'user', agent: {} });
      await instance.prepare();
      await instance.start('input');
      await flush();
      expect(instance.getSnapshot().run?.error?.code).toBe('unsupported');
    } else expect(f.instance.getSnapshot().run?.error?.code).toBe('unsupported');
  },
);

test.each([
  {
    components: { root: { id: 'root', component: 'Unknown' } },
    code: 'unsupported',
    protocol: 'UNKNOWN_COMPONENT',
  },
  { components: {}, code: 'invalid', protocol: 'MISSING_ROOT' },
  {
    components: { root: { id: 'root', component: 'Quiz', answer: '', children: ['root'] } },
    code: 'invalid',
    protocol: 'CYCLIC_COMPONENTS',
  },
])(
  'rejects invalid catalog/graph state with fixed diagnostics: $protocol',
  async ({ components, code, protocol }) => {
    const f = await fixture([
      record({ components: components as MaterializedSurface['components'] }),
    ]);
    expect(f.instance.getSnapshot().run?.error).toEqual({
      code,
      message:
        code === 'unsupported' ? 'This operation is unsupported.' : 'The request is invalid.',
    });
    expect(f.instance.getSnapshot().run?.pending).toBeUndefined();
    expect(f.diagnostics).toContainEqual(expect.objectContaining({ protocolCode: protocol }));
  },
);

test.each([1, 3])('rejects a repeated or skipped second revision %s', async (revision) => {
  const f = await fixture([record(), record({ revision })]);
  expect(await f.instance.dispatch(f.event)).toMatchObject({ status: 'accepted' });
  await flush();
  expect(f.instance.getSnapshot().run?.error?.code).toBe('invalid');
});

test('requires first revision 1, accepts exactly +1, and gives new render-outcome identity', async () => {
  const invalid = await fixture([record({ revision: 2 })]);
  expect(invalid.instance.getSnapshot().run?.error?.code).toBe('invalid');
  const f = await fixture([record(), record({ revision: 2 })]);
  f.instance.recordRenderOutcome({
    runId: f.event.runId,
    interactionId: f.event.interactionId,
    viewRevision: f.event.viewRevision,
    status: 'failed',
    code: 'render_failed',
  });
  expect(await f.instance.dispatch(f.event)).toMatchObject({ status: 'accepted' });
  await flush();
  expect(f.instance.getSnapshot().run?.pending?.surface?.revision).toBe(2);
  expect(f.instance.getSnapshot().run?.pending?.viewRevision).toBe('lesson#2');
});

test.each(['component', 'model'] as const)(
  'registers typed data before inbox acceptance and blocks later %s URLs',
  async (location) => {
    const secret = 'Typed private sentence';
    const url = `https://example.test/?q=${encodeURIComponent(secret)}`;
    const second = record({
      revision: 2,
      ...(location === 'component'
        ? { components: { root: { id: 'root', component: 'Quiz', answer: '', url } } }
        : { dataModel: { answer: '', link: url } }),
    });
    const store = new MemoryRecoveryStore();
    const f = await fixture([record(), second], ui, store);
    const registered = vi.spyOn(privatePolicy, 'registerPrivate');
    const accept = store.acceptSubmission.bind(store);
    vi.spyOn(store, 'acceptSubmission').mockImplementation(async (...args) => {
      expect(
        registered.mock.calls.some(
          ([values, registeredValues]) =>
            Array.isArray(values) &&
            values.includes(secret) &&
            registeredValues.has(secret.toLowerCase()),
        ),
      ).toBe(true);
      // No domain payload contains the model's typed text.
      expect(JSON.stringify(args)).not.toContain(secret);
      return accept(...args);
    });
    const result = await f.instance.dispatch({
      ...f.event,
      surfaceAction: {
        revision: 1,
        componentId: 'root',
        dataModel: { ...record().dataModel, answer: secret },
      },
    });
    expect(result.status).toBe('accepted');
    expect(f.instance.getSnapshot().run?.labels).toContain('private-user');
    await flush();
    expect(f.instance.getSnapshot().run?.error).toEqual({
      code: 'denied',
      message: 'Policy denied the request.',
    });
    expect(f.instance.getSnapshot().run?.pending).toBeUndefined();
    const events = await collect(f.instance.events(f.event.runId));
    expect(events.filter((event) => event.type === 'interaction')).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(secret);
  },
);

test('related decoded pointer paths are writable; unbound siblings and prefix lookalikes are not', () => {
  const value = record();
  expect(
    surfaceModelChanges(value, { answer: 'typed', fixed: 'unchanged' })?.privateStrings,
  ).toEqual(['typed']);
  expect(surfaceModelChanges(value, { ...value.dataModel, answerExtra: 'no' })).toBeUndefined();
  expect(surfaceModelChanges(value, { answer: '', fixed: 'no' })).toBeUndefined();
  expect(surfaceModelChanges(value, { answer: 1n })).toBeUndefined();
  expect(checkSurfaceUrls(record({ dataModel: { nested: ['javascript:alert(1)'] } }), [])).toBe(
    false,
  );
});

test('restore selects the exact historical pin, restores conservative labels and seeds revision continuity', async () => {
  const old = record({ specVersion: 'old', specRevision: 'old-commit', revision: 7 });
  expect(old.specRevision).not.toBe(A2UI_SPEC_REVISION);
  const executor = new FakeExecutor();
  Object.assign(executor.features, { resume: true, checkpoints: true });
  executor.agent.pending = async () => pending(old);
  const validator = vi.fn((value: unknown) => ({
    ok: true as const,
    surface: value as MaterializedSurface,
  }));
  const policy = createSurfacePolicy({
    validators: [{ specVersion: 'old', specRevision: 'old-commit', validate: validator }],
  });
  const make = (surfacePolicy = createSurfacePolicy()) =>
    createAgentInstance(
      definition,
      executor,
      { principalScope: 'user', agent: {}, ui },
      {
        appId: 'pins',
        tracer: trace.getTracer('pins'),
        limits: DEFAULT_BUDGETS,
        policy: DEFAULT_DATA_POLICY,
        urlAllowlist: [],
        surfacePolicy,
      },
      () => {},
    ).instance;
  const refused = make();
  disposables.push(refused);
  await refused.prepare();
  await expect(refused.restore()).rejects.toMatchObject({ code: 'unsupported' });
  expect(refused.getSnapshot().run).toBeUndefined();
  const restored = make(policy);
  disposables.push(restored);
  await restored.prepare();
  await restored.restore();
  expect(validator).toHaveBeenCalledOnce();
  expect(restored.getSnapshot().run?.pending?.surface).toMatchObject({
    ...old,
    labels: ['app', 'private-user', 'public'],
  });
  expect(restored.getSnapshot().run?.pending?.viewRevision).toBe('lesson#7');
  expect(createSurfacePolicy().validate(record(), context).ok).toBe(true);
  expect(validateSurface(record(), context).ok).toBe(true);
});

test('relative list-template bindings authorize their resolved paths without authorizing sibling data', () => {
  const listCatalog: Catalog = {
    id: 'list/v1',
    components: {
      Column: { children: ['children'], props: sync(z.object({ children: z.unknown() }).strict()) },
      Input: { bindable: ['value'], props: sync(z.object({ value: z.string() }).strict()) },
    },
  };
  const value = record({
    catalogId: listCatalog.id,
    components: {
      root: { id: 'root', component: 'Column', children: { componentId: 'input', path: '/rows' } },
      input: { id: 'input', component: 'Input', value: { '@path': 'name' } },
    },
    dataModel: { rows: [{ name: '', fixed: 1 }], 'a/b': '' },
  });
  expect(
    surfaceModelChanges(value, { rows: [{ name: 'typed', fixed: 1 }], 'a/b': '' }, listCatalog)
      ?.privateStrings,
  ).toEqual(['typed']);
  expect(
    surfaceModelChanges(value, { rows: [{ name: '', fixed: 2 }], 'a/b': '' }, listCatalog),
  ).toBeUndefined();
  const escaped = record({
    components: { root: { id: 'root', component: 'Quiz', answer: { '@path': '/a~1b' } } },
    dataModel: { 'a/b': '' },
  });
  expect(surfaceModelChanges(escaped, { 'a/b': 'typed' })?.privateStrings).toEqual(['typed']);
});

test('core replaces adapter-supplied labels, view token, root props and region with the validated projection', async () => {
  const projected = pending();
  const surface = projected.surface;
  if (surface === undefined) throw new Error('The test surface is missing.');
  const forged: PendingInteraction = {
    ...projected,
    props: { forged: true },
    surfaceId: 'other',
    viewRevision: 'forged' as PendingInteraction['viewRevision'],
    surface: {
      ...surface,
      viewRevision: 'forged' as PendingInteraction['viewRevision'],
      labels: ['private-user'],
    },
  };
  const executor = new FakeExecutor([[{ type: 'interaction', interaction: forged }]]);
  const runtime = createRuntime({ appId: 'projection', executors: [executor] });
  disposables.push(runtime);
  const instance = await runtime.create(definition, { principalScope: 'user', agent: {}, ui });
  await instance.prepare();
  await instance.start('input');
  await flush();
  expect(instance.getSnapshot().run?.pending).toMatchObject({
    surfaceId: 'main',
    viewRevision: 'lesson#1',
    props: { answer: { '@path': '/answer' }, children: ['text'] },
  });
  expect(instance.getSnapshot().run?.pending?.surface?.labels).toEqual(
    instance.getSnapshot().run?.labels,
  );
});

test('the run component and byte limits apply to publication and the complete submitted model', async () => {
  const count = await fixture([record()], ui, undefined, { uiElements: 1 });
  expect(count.instance.getSnapshot().run?.error?.code).toBe('budget_exceeded');
  const bytes = new TextEncoder().encode(JSON.stringify(record())).byteLength;
  const tooLarge = await fixture([record()], ui, undefined, { payloadBytes: bytes - 1 });
  expect(tooLarge.instance.getSnapshot().run?.error?.code).toBe('budget_exceeded');
  const action = await fixture([record()], ui, undefined, { payloadBytes: bytes + 100 });
  expect(
    await action.instance.dispatch({
      ...action.event,
      surfaceAction: {
        revision: 1,
        componentId: 'root',
        dataModel: { ...record().dataModel, answer: 'x'.repeat(bytes + 100) },
      },
    }),
  ).toMatchObject({ error: { code: 'budget_exceeded' } });
  expect(action.executor.requests).toHaveLength(1);
});

test('restore registers record strings before URL policy even when an executor supplies no restored-data hook', async () => {
  const secret = 'Previously entered private text';
  const value = record({
    dataModel: { answer: secret, link: `https://example.test/?q=${encodeURIComponent(secret)}` },
  });
  const executor = new FakeExecutor();
  Object.assign(executor.features, { resume: true, checkpoints: true });
  executor.agent.pending = async () => pending(value);
  const runtime = createRuntime({
    appId: 'restore-privacy',
    executors: [executor],
    urlAllowlist: ['https://example.test'],
  });
  disposables.push(runtime);
  const instance = await runtime.create(definition, { principalScope: 'user', agent: {}, ui });
  await instance.prepare();
  await expect(instance.restore()).rejects.toMatchObject({
    code: 'denied',
    message: 'Policy denied the request.',
  });
  expect(instance.getSnapshot().run).toBeUndefined();
});

test('surface JSON rejects exotic arrays without invoking getters or serialization hooks', () => {
  let reads = 0;
  const array: unknown[] = [];
  Object.defineProperty(array, '0', {
    enumerable: true,
    get() {
      reads++;
      return 'value';
    },
  });
  expect(parseSurfaceRecord({ ...record(), dataModel: { values: array } })).toBeUndefined();
  expect(reads).toBe(0);
  const decorated = Object.assign(['value'], {
    toJSON: () => {
      reads++;
      return [];
    },
  });
  expect(parseSurfaceRecord({ ...record(), dataModel: { values: decorated } })).toBeUndefined();
  expect(reads).toBe(0);
});

test('publication rechecks private values registered while the recovery consumption write is pending', async () => {
  const secret = 'Late private capability value';
  const second = record({
    revision: 2,
    dataModel: { answer: '', link: `https://example.test/?q=${encodeURIComponent(secret)}` },
  });
  const store = new MemoryRecoveryStore();
  const entered = deferred<void>();
  const held = deferred<void>();
  const consume = store.consumeSubmission.bind(store);
  vi.spyOn(store, 'consumeSubmission').mockImplementation(async (...args) => {
    await consume(...args);
    entered.resolve();
    await held.promise;
  });
  const f = await fixture([record(), second], ui, store);
  try {
    expect(await f.instance.dispatch(f.event)).toMatchObject({ status: 'accepted' });
    await entered.promise;
    f.executor.requests[1]?.registerRestoredData?.(secret);
    held.resolve();
    await flush();
    expect(f.instance.getSnapshot().run?.error).toEqual({
      code: 'denied',
      message: 'Policy denied the request.',
    });
    const events = await collect(f.instance.events(f.event.runId));
    expect(events.filter((event) => event.type === 'interaction')).toHaveLength(1);
  } finally {
    held.resolve();
  }
});
