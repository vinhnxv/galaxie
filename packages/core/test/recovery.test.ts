// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test, vi } from 'vitest';
import {
  createRuntime,
  type DiagnosticEvent,
  type InteractionId,
  type PendingInteraction,
  type RecoverySubmission,
  type SessionId,
  toErrorInfo,
  type UserInteractionEvent,
  type ViewRevision,
} from '../src/index.js';
import { copyRecoveryJson, validateEffectRecord, validateSubmissions } from '../src/recovery.js';
import { deferred, definition, FakeExecutor, flush, type Script } from './fake-executor.js';
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
  await instance.prepare();
  await expect(instance.restore()).rejects.toMatchObject({
    code: 'unrecoverable',
    message: 'Stored state cannot be recovered.',
  });
  expect(instance.getSnapshot().run).toBeUndefined();
  await runtime.dispose();
});
