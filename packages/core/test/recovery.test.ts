// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import {
  type CreateOptions,
  createRuntime,
  type DiagnosticEvent,
  galaxieField,
  type InteractionId,
  type PendingInteraction,
  type RecoverySubmission,
  type SessionId,
  toErrorInfo,
  type UserInteractionEvent,
  type ViewRevision,
} from '../src/index.js';
import { copyRecoveryJson, validateEffectRecord, validateSubmissions } from '../src/recovery.js';
import {
  binding,
  deferred,
  definition,
  FakeExecutor,
  flush,
  type Script,
} from './fake-executor.js';
import { MemoryRecoveryStore } from './support/memory-recovery-store.js';

const interaction: PendingInteraction = {
  interactionId: 'answer' as InteractionId,
  surfaceId: 'main',
  viewRevision: 'r1' as ViewRevision,
  component: 'tests.Question/v1',
  props: {},
};

async function waiting(
  store = new MemoryRecoveryStore(),
  script: Script = [{ type: 'output', output: 'done' }],
) {
  const executor = new FakeExecutor([[{ type: 'interaction', interaction }], script]);
  Object.assign(executor.features, { resume: true, checkpoints: true });
  executor.agent.pending = async () => interaction;
  const diagnostics: DiagnosticEvent[] = [];
  const runtime = createRuntime({
    appId: 'recovery-tests',
    executors: [executor],
    diagnostics: (event) => diagnostics.push(event),
  });
  const instance = await runtime.create(definition, {
    principalScope: 'user',
    agent: {},
    recovery: store,
  });
  await instance.prepare();
  const { runId } = await instance.start('input');
  await flush();
  const event: UserInteractionEvent = {
    instanceId: instance.instanceId,
    runId,
    ...interaction,
    action: 'submit',
    payload: { answer: 'private answer' },
  };
  return { runtime, instance, executor, diagnostics, store, event };
}

test('dispatch waits for durable acceptance before returning or resuming', async () => {
  const store = new MemoryRecoveryStore();
  const held = deferred<void>();
  const accept = store.acceptSubmission.bind(store);
  store.acceptSubmission = async (...args) => {
    await held.promise;
    return accept(...args);
  };
  const fixture = await waiting(store);
  let returned = false;
  const receipt = fixture.instance.dispatch(fixture.event).then((result) => {
    returned = true;
    return result;
  });
  await flush();
  expect(returned).toBe(false);
  expect(fixture.executor.requests).toHaveLength(1);
  held.resolve();
  expect(await receipt).toEqual({ status: 'accepted', interactionId: interaction.interactionId });
  await flush();
  const sessionId = fixture.executor.requests[0]?.sessionId as SessionId;
  expect(await store.submissions(sessionId)).toEqual([
    {
      interactionId: interaction.interactionId,
      action: 'submit',
      payload: fixture.event.payload,
      status: 'consumed',
    },
  ]);
  await fixture.runtime.dispose();
});

test('failed durable acceptance leaves the interrupt available and never starts a resume', async () => {
  const fixture = await waiting();
  vi.spyOn(fixture.store, 'acceptSubmission').mockRejectedValue(new Error('host failure'));
  expect(await fixture.instance.dispatch(fixture.event)).toMatchObject({
    status: 'rejected',
    error: { code: 'unavailable' },
  });
  expect(fixture.executor.requests).toHaveLength(1);
  expect(fixture.instance.getSnapshot().run?.status).toBe('waiting_input');
  expect(fixture.diagnostics).toContainEqual(expect.objectContaining({ kind: 'dispatch_failed' }));
  await fixture.runtime.dispose();
});

test('dispose during durable acceptance leaves an accepted answer without resuming', async () => {
  const store = new MemoryRecoveryStore();
  const held = deferred<void>();
  const accepted = deferred<void>();
  const accept = store.acceptSubmission.bind(store);
  store.acceptSubmission = async (...args) => {
    const result = await accept(...args);
    accepted.resolve();
    await held.promise;
    return result;
  };
  const fixture = await waiting(store);
  const receipt = fixture.instance.dispatch(fixture.event);
  await accepted.promise;
  const disposing = fixture.runtime.dispose();
  await flush();
  held.resolve();
  expect(await receipt).toMatchObject({ status: 'rejected', error: { code: 'stale' } });
  await disposing;
  expect(fixture.executor.requests).toHaveLength(1);
  expect([...store.inbox.values()][0]?.status).toBe('accepted');
});

test('concurrent submissions and durable receipts both reject duplicate answers', async () => {
  const fixture = await waiting();
  const first = fixture.instance.dispatch(fixture.event);
  expect(await fixture.instance.dispatch(fixture.event)).toMatchObject({
    status: 'rejected',
    error: { code: 'duplicate' },
  });
  expect(await first).toMatchObject({ status: 'accepted' });
  await flush();
  const sessionId = fixture.executor.requests[0]?.sessionId as SessionId;
  expect(
    await fixture.store.acceptSubmission(sessionId, {
      interactionId: interaction.interactionId,
      action: 'submit',
      payload: false,
    }),
  ).toBe('duplicate');
  expect(await fixture.instance.dispatch(fixture.event)).toMatchObject({
    status: 'rejected',
    error: { code: 'duplicate' },
  });
  await fixture.runtime.dispose();
});

test.each(['output', 'interaction'] as const)(
  'consumption is durable before publishing a %s boundary',
  async (type) => {
    const next = { ...interaction, interactionId: 'next' as InteractionId };
    const fixture = await waiting(
      new MemoryRecoveryStore(),
      type === 'output' ? [{ type, output: 'done' }] : [{ type, interaction: next }],
    );
    const held = deferred<void>();
    const consuming = deferred<void>();
    const consume = fixture.store.consumeSubmission.bind(fixture.store);
    fixture.store.consumeSubmission = async (...args) => {
      consuming.resolve();
      await held.promise;
      await consume(...args);
    };
    await fixture.instance.dispatch(fixture.event);
    await consuming.promise;
    expect(fixture.instance.getSnapshot().run).toMatchObject({
      status: 'running',
      submission: { status: 'accepted' },
    });
    held.resolve();
    await flush();
    expect(fixture.instance.getSnapshot().run).toMatchObject({
      status: type === 'output' ? 'succeeded' : 'waiting_input',
      submission: { status: 'consumed' },
    });
    await fixture.runtime.dispose();
  },
);

test.each([
  ['error', [{ type: 'error', error: toErrorInfo('executor_error') }]],
  ['throw', [{ throw: new Error('host failure') }]],
  ['missing terminal event', []],
  ['repeated interrupt', [{ type: 'interaction', interaction }]],
] as const)('a resume with %s keeps its durable answer accepted', async (_name, script) => {
  const fixture = await waiting(new MemoryRecoveryStore(), script);
  await fixture.instance.dispatch(fixture.event);
  await flush();
  expect(fixture.instance.getSnapshot().run?.status).toBe('failed');
  expect([...fixture.store.inbox.values()][0]?.status).toBe('accepted');
  await fixture.runtime.dispose();
});

test('cancellation before a checkpoint boundary keeps the answer accepted', async () => {
  const held = deferred<void>();
  const fixture = await waiting(new MemoryRecoveryStore(), [
    { wait: held.promise },
    { type: 'output', output: 'done' },
  ]);
  await fixture.instance.dispatch(fixture.event);
  await flush();
  await fixture.instance.cancel(fixture.event.runId);
  held.resolve();
  await fixture.runtime.dispose();
  expect([...fixture.store.inbox.values()][0]?.status).toBe('accepted');
});

test('consume failure leaves recovery work without failing the completed run', async () => {
  const fixture = await waiting();
  vi.spyOn(fixture.store, 'consumeSubmission').mockRejectedValue(new Error('store failure'));
  await fixture.instance.dispatch(fixture.event);
  await flush();
  expect(fixture.instance.getSnapshot().run).toMatchObject({
    status: 'succeeded',
    submission: { status: 'accepted' },
  });
  expect([...fixture.store.inbox.values()][0]?.status).toBe('accepted');
  expect(fixture.diagnostics).toContainEqual(expect.objectContaining({ kind: 'dispatch_failed' }));
  await fixture.runtime.dispose();
});

test.each(['accepted', 'consumed'] as const)(
  'restored durable %s receipts reject duplicate dispatches',
  async (status) => {
    const store = new MemoryRecoveryStore();
    const sessionId = crypto.randomUUID() as SessionId;
    await store.acceptSubmission(sessionId, {
      interactionId: interaction.interactionId,
      action: 'submit',
      payload: true,
    });
    if (status === 'consumed') await store.consumeSubmission(sessionId, interaction.interactionId);
    const executor = new FakeExecutor();
    Object.assign(executor.features, { resume: true, checkpoints: true });
    executor.agent.pending = async () => interaction;
    const runtime = createRuntime({ appId: 'recovery-tests', executors: [executor] });
    const instance = await runtime.create(definition, {
      principalScope: 'user',
      agent: {},
      sessionId,
      recovery: store,
    });
    await store.recordSession(instance.sessionId, {
      agentId: definition.id,
      agentVersion: definition.version,
      executorId: 'fake',
    });
    await instance.prepare();
    const restored = await instance.restore();
    expect(restored).toBeDefined();
    expect(
      await instance.dispatch({
        instanceId: instance.instanceId,
        runId: restored?.runId as UserInteractionEvent['runId'],
        ...interaction,
        action: 'submit',
        payload: true,
      }),
    ).toMatchObject({ status: 'rejected', error: { code: 'duplicate' } });
    await runtime.dispose();
  },
);

test('recovery rejects malformed records without including stored content', () => {
  const entry = {
    interactionId: 'answer',
    action: 'submit',
    payload: 'private answer',
    status: 'accepted',
  };
  for (const value of [
    null,
    {},
    [entry, entry],
    [{ ...entry, status: 'unknown' }],
    [{ ...entry, payload: undefined }],
  ]) {
    expect(() => validateSubmissions(value)).toThrow(
      expect.objectContaining({
        code: 'unrecoverable',
        message: 'Stored state cannot be recovered.',
      }),
    );
  }
  for (const value of [new Date(), undefined, Number.NaN, { value: () => undefined }]) {
    expect(() => copyRecoveryJson(value)).toThrow(
      expect.objectContaining({ code: 'unrecoverable' }),
    );
  }
  expect(() => validateEffectRecord({ status: 'succeeded', inputDigest: '0'.repeat(64) })).toThrow(
    expect.objectContaining({ code: 'unrecoverable' }),
  );
  expect(
    validateEffectRecord({ status: 'succeeded', inputDigest: '0'.repeat(64), output: null }),
  ).toEqual({ status: 'succeeded', inputDigest: '0'.repeat(64), output: null });
  expect(toErrorInfo('outcome_unknown')).toEqual({
    code: 'outcome_unknown',
    message: 'The outcome of an earlier call is unknown.',
  });
});

test('restore validates returned records before publishing a run', async () => {
  const store = new MemoryRecoveryStore();
  store.submissions = async () => [
    {
      interactionId: 'answer',
      action: 'submit',
      payload: 'private answer',
      status: 'broken',
    } as unknown as RecoverySubmission,
  ];
  const executor = new FakeExecutor();
  Object.assign(executor.features, { resume: true, checkpoints: true });
  executor.agent.pending = async () => interaction;
  const runtime = createRuntime({ appId: 'recovery-tests', executors: [executor] });
  const instance = await runtime.create(definition, {
    principalScope: 'user',
    agent: {},
    sessionId: crypto.randomUUID() as SessionId,
    recovery: store,
  });
  await store.recordSession(instance.sessionId, {
    agentId: definition.id,
    agentVersion: definition.version,
    executorId: 'fake',
  });
  await instance.prepare();
  await expect(instance.restore()).rejects.toMatchObject({
    code: 'unrecoverable',
    message: 'Stored state cannot be recovered.',
  });
  expect(instance.getSnapshot().run).toBeUndefined();
  await runtime.dispose();
});

async function restoreFixture(
  store: MemoryRecoveryStore,
  sessionId: SessionId,
  pending: PendingInteraction | undefined = interaction,
  script: Script = [{ type: 'output', output: 'done' }],
  options: Partial<CreateOptions> = {},
) {
  const executor = new FakeExecutor([script]);
  Object.assign(executor.features, { resume: true, checkpoints: true });
  executor.agent.pending = async () => pending;
  const diagnostics: DiagnosticEvent[] = [];
  const runtime = createRuntime({
    appId: 'recovery-tests',
    executors: [executor],
    diagnostics: (event) => diagnostics.push(event),
  });
  const instance = await runtime.create(definition, {
    principalScope: 'user',
    agent: {},
    sessionId,
    recovery: store,
    ...options,
  });
  await store.recordSession(instance.sessionId, {
    agentId: definition.id,
    agentVersion: definition.version,
    executorId: 'fake',
  });
  await instance.prepare();
  return { runtime, instance, executor, diagnostics };
}

test('restore automatically resumes an accepted answer without publishing its pending UI', async () => {
  const store = new MemoryRecoveryStore();
  const sessionId = crypto.randomUUID() as SessionId;
  await store.acceptSubmission(sessionId, {
    interactionId: interaction.interactionId,
    action: 'submit',
    payload: { answer: 'stored private answer' },
  });
  const gate = deferred<void>();
  const fixture = await restoreFixture(store, sessionId, interaction, [
    { wait: gate.promise },
    { type: 'output', output: 'done' },
  ]);
  const snapshots: unknown[] = [];
  fixture.instance.subscribe(() => snapshots.push(fixture.instance.getSnapshot()));
  const restored = await fixture.instance.restore();
  expect(restored).toBeDefined();
  expect(fixture.instance.getSnapshot().run).toMatchObject({
    status: 'running',
    submission: { interactionId: interaction.interactionId, status: 'accepted' },
  });
  expect(fixture.instance.getSnapshot().run?.pending).toBeUndefined();
  await flush();
  expect(fixture.executor.requests).toHaveLength(1);
  expect(fixture.executor.requests[0]?.command).toEqual({
    type: 'resume',
    interactionId: interaction.interactionId,
    action: 'submit',
    payload: { answer: 'stored private answer' },
  });
  expect(JSON.stringify(snapshots)).not.toContain('stored private answer');
  expect(
    snapshots.every((snapshot) => !(snapshot as { run?: { pending?: unknown } }).run?.pending),
  ).toBe(true);
  gate.resolve();
  await flush();
  expect(fixture.instance.getSnapshot().run?.status).toBe('succeeded');
  expect((await store.submissions(sessionId))[0]?.status).toBe('consumed');
  await fixture.runtime.dispose();
});

test.each([true, false])(
  'restore consumes resolved accepted entries before publication: pending=%s',
  async (hasPending) => {
    const store = new MemoryRecoveryStore();
    const sessionId = crypto.randomUUID() as SessionId;
    await store.acceptSubmission(sessionId, {
      interactionId: 'resolved' as InteractionId,
      action: 'submit',
      payload: 'answer',
    });
    const gate = deferred<void>();
    const consuming = deferred<void>();
    const consume = store.consumeSubmission.bind(store);
    store.consumeSubmission = async (...args) => {
      consuming.resolve();
      await gate.promise;
      await consume(...args);
    };
    const fixture = await restoreFixture(store, sessionId, hasPending ? interaction : undefined);
    if (!hasPending) fixture.executor.agent.pending = async () => undefined;
    const published = vi.fn();
    fixture.instance.subscribe(published);
    const restoring = fixture.instance.restore();
    await consuming.promise;
    expect(published).not.toHaveBeenCalled();
    expect(fixture.instance.getSnapshot().run).toBeUndefined();
    gate.resolve();
    const result = await restoring;
    if (hasPending) {
      expect(result).toBeDefined();
      expect(fixture.instance.getSnapshot().run?.pending).toEqual(interaction);
    } else expect(result).toBeUndefined();
    expect((await store.submissions(sessionId))[0]?.status).toBe('consumed');
    expect(fixture.executor.requests).toHaveLength(0);
    await fixture.runtime.dispose();
  },
);

test('a crash before durable acceptance restores the interrupt and submits once', async () => {
  const store = new MemoryRecoveryStore();
  const entered = deferred<void>();
  const gate = deferred<void>();
  const accept = store.acceptSubmission.bind(store);
  store.acceptSubmission = async () => {
    entered.resolve();
    await gate.promise;
    throw new Error('aborted transaction');
  };
  const first = await waiting(store);
  const submitting = first.instance.dispatch(first.event);
  await entered.promise;
  const disposal = first.runtime.dispose();
  gate.resolve();
  await submitting;
  await disposal;
  expect(store.inbox.size).toBe(0);
  store.acceptSubmission = accept;
  const second = await restoreFixture(store, first.instance.sessionId);
  const restored = await second.instance.restore();
  expect(second.instance.getSnapshot().run?.status).toBe('waiting_input');
  expect(
    await second.instance.dispatch({
      ...first.event,
      instanceId: second.instance.instanceId,
      runId: restored?.runId as UserInteractionEvent['runId'],
    }),
  ).toMatchObject({ status: 'accepted' });
  await flush();
  expect(second.executor.requests).toHaveLength(1);
  expect(second.instance.getSnapshot().run?.status).toBe('succeeded');
  await second.runtime.dispose();
});

test('a crash after acceptance restores and applies the stored answer once', async () => {
  const store = new MemoryRecoveryStore();
  const accepted = deferred<void>();
  const gate = deferred<void>();
  const accept = store.acceptSubmission.bind(store);
  store.acceptSubmission = async (...args) => {
    const result = await accept(...args);
    accepted.resolve();
    await gate.promise;
    return result;
  };
  const first = await waiting(store);
  const submitting = first.instance.dispatch(first.event);
  await accepted.promise;
  const disposal = first.runtime.dispose();
  gate.resolve();
  expect(await submitting).toMatchObject({ status: 'rejected', error: { code: 'stale' } });
  await disposal;
  let applied = 0;
  const second = await restoreFixture(
    store,
    first.instance.sessionId,
    interaction,
    async function* () {
      applied++;
      yield { type: 'output', output: 'done' };
    },
  );
  await second.instance.restore();
  await flush();
  expect(applied).toBe(1);
  expect(second.executor.requests[0]?.command).toMatchObject({ payload: first.event.payload });
  expect((await store.submissions(first.instance.sessionId))[0]?.status).toBe('consumed');
  await second.runtime.dispose();
});

test('a crash after the resume checkpoint reconciles consumption without resuming again', async () => {
  const store = new MemoryRecoveryStore();
  const consuming = deferred<void>();
  const gate = deferred<void>();
  const consume = store.consumeSubmission.bind(store);
  store.consumeSubmission = async () => {
    consuming.resolve();
    await gate.promise;
    throw new Error('aborted transaction');
  };
  const first = await waiting(store);
  await first.instance.dispatch(first.event);
  await consuming.promise;
  const disposal = first.runtime.dispose();
  gate.resolve();
  await disposal;
  expect((await store.submissions(first.instance.sessionId))[0]?.status).toBe('accepted');
  store.consumeSubmission = consume;
  const second = await restoreFixture(store, first.instance.sessionId);
  second.executor.agent.pending = async () => undefined;
  expect(await second.instance.restore()).toBeUndefined();
  expect(second.executor.requests).toHaveLength(0);
  expect((await store.submissions(first.instance.sessionId))[0]?.status).toBe('consumed');
  await second.runtime.dispose();
});

test('a crash after consumption keeps the receipt and has nothing to resume', async () => {
  const first = await waiting();
  await first.instance.dispatch(first.event);
  await flush();
  await first.runtime.dispose();
  const second = await restoreFixture(first.store, first.instance.sessionId);
  second.executor.agent.pending = async () => undefined;
  expect(await second.instance.restore()).toBeUndefined();
  expect(second.executor.requests).toHaveLength(0);
  expect(
    await first.store.acceptSubmission(first.instance.sessionId, {
      interactionId: interaction.interactionId,
      action: 'submit',
      payload: 'replacement',
    }),
  ).toBe('duplicate');
  await second.runtime.dispose();
});

test('a failed resume remains accepted and a later restore resumes it once', async () => {
  const first = await waiting(new MemoryRecoveryStore(), [
    { type: 'error', error: toErrorInfo('executor_error') },
  ]);
  await first.instance.dispatch(first.event);
  await flush();
  expect(first.instance.getSnapshot().run?.status).toBe('failed');
  await first.runtime.dispose();
  const second = await restoreFixture(first.store, first.instance.sessionId);
  await second.instance.restore();
  await flush();
  expect(second.executor.requests).toHaveLength(1);
  expect(second.executor.requests[0]?.command).toMatchObject({ payload: first.event.payload });
  expect(second.instance.getSnapshot().run?.status).toBe('succeeded');
  await second.runtime.dispose();
});

test.each(['action', 'payload', 'url', 'component'] as const)(
  'automatic resume repeats live %s checks before publishing a run',
  async (failure) => {
    const store = new MemoryRecoveryStore();
    const sessionId = crypto.randomUUID() as SessionId;
    await store.acceptSubmission(sessionId, {
      interactionId: interaction.interactionId,
      action: failure === 'action' ? 'unknown' : 'submit',
      payload: failure === 'payload' ? false : 'private answer',
    });
    const fixture = await restoreFixture(
      store,
      sessionId,
      {
        ...interaction,
        props: failure === 'url' ? { url: 'https://denied.example/private' } : {},
      },
      undefined,
      {
        ui: {
          components:
            failure === 'component'
              ? {}
              : {
                  'tests.Question/v1': { actions: { submit: { payload: z.string() } } },
                },
          surfaces: ['main'],
        },
      },
    );
    await expect(fixture.instance.restore()).rejects.toMatchObject({
      code: failure === 'url' ? 'denied' : failure === 'component' ? 'unsupported' : 'invalid',
    });
    expect(fixture.instance.getSnapshot().run).toBeUndefined();
    expect(fixture.executor.requests).toHaveLength(0);
    expect((await store.submissions(sessionId))[0]?.status).toBe('accepted');
    await fixture.runtime.dispose();
  },
);

test('disposal during reconciliation never publishes or starts a restored run', async () => {
  const store = new MemoryRecoveryStore();
  const sessionId = crypto.randomUUID() as SessionId;
  await store.acceptSubmission(sessionId, {
    interactionId: 'resolved' as InteractionId,
    action: 'submit',
    payload: 'answer',
  });
  const gate = deferred<void>();
  const consuming = deferred<void>();
  const consume = store.consumeSubmission.bind(store);
  store.consumeSubmission = async (...args) => {
    consuming.resolve();
    await gate.promise;
    await consume(...args);
  };
  const fixture = await restoreFixture(store, sessionId);
  const restoring = fixture.instance.restore();
  const rejected = expect(restoring).rejects.toMatchObject({ code: 'invalid' });
  await consuming.promise;
  const disposal = fixture.runtime.dispose();
  gate.resolve();
  await rejected;
  await disposal;
  expect(fixture.instance.getSnapshot().run).toBeUndefined();
  expect(fixture.executor.requests).toHaveLength(0);
});

test('automatic resume restores schema-labelled private strings before capability access', async () => {
  const store = new MemoryRecoveryStore();
  const sessionId = crypto.randomUUID() as SessionId;
  await store.acceptSubmission(sessionId, {
    interactionId: interaction.interactionId,
    action: 'submit',
    payload: { answer: 'private answer' },
  });
  const invoke = vi.fn(async () => 'done');
  let failure: unknown;
  const executor = new FakeExecutor([
    async function* (request) {
      try {
        await request.capabilities.call('send@1', 'private answer');
      } catch (error) {
        failure = error;
      }
      yield { type: 'output', output: 'done' };
    },
  ]);
  Object.assign(executor.features, { resume: true, checkpoints: true });
  executor.agent.pending = async () => interaction;
  const runtime = createRuntime({ appId: 'recovery-tests', executors: [executor] });
  const instance = await runtime.create(
    {
      ...definition,
      capabilities: {
        optional: {
          'send@1': { kind: 'read', input: z.enum(['private answer']), output: z.string() },
        },
      },
    },
    {
      principalScope: 'user',
      agent: {},
      sessionId,
      recovery: store,
      ui: {
        components: {
          'tests.Question/v1': {
            actions: {
              submit: {
                payload: z.object({
                  answer: z
                    .string()
                    .meta(galaxieField({ label: 'private-user', shape: 'freeText' })),
                }),
              },
            },
          },
        },
        surfaces: ['main'],
      },
      bindings: { 'send@1': { ...binding({ destination: 'host-server' }), invoke } },
    },
  );
  await store.recordSession(instance.sessionId, {
    agentId: definition.id,
    agentVersion: definition.version,
    executorId: 'fake',
  });
  await instance.prepare();
  await instance.restore();
  await flush();
  expect(failure).toMatchObject({ code: 'denied' });
  expect(invoke).not.toHaveBeenCalled();
  expect(instance.getSnapshot().run?.status).toBe('succeeded');
  await runtime.dispose();
});

test('reconciliation store failure preserves the accepted entry and leaves restore retryable', async () => {
  const store = new MemoryRecoveryStore();
  const sessionId = crypto.randomUUID() as SessionId;
  await store.acceptSubmission(sessionId, {
    interactionId: 'resolved' as InteractionId,
    action: 'submit',
    payload: 'private answer',
  });
  const consume = vi
    .spyOn(store, 'consumeSubmission')
    .mockRejectedValueOnce(new Error('private failure'));
  const fixture = await restoreFixture(store, sessionId);
  await expect(fixture.instance.restore()).rejects.toMatchObject({
    code: 'unavailable',
    message: 'The requested service is unavailable.',
  });
  expect(fixture.instance.getSnapshot().run).toBeUndefined();
  expect((await store.submissions(sessionId))[0]?.status).toBe('accepted');
  expect(fixture.diagnostics).toContainEqual(expect.objectContaining({ kind: 'restore_failed' }));
  consume.mockRestore();
  await fixture.instance.restore();
  expect(fixture.instance.getSnapshot().run?.status).toBe('waiting_input');
  expect((await store.submissions(sessionId))[0]?.status).toBe('consumed');
  await fixture.runtime.dispose();
});
