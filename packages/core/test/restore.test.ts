// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import {
  createRuntime,
  type DiagnosticEvent,
  GalaxieError,
  galaxieField,
  type PendingInteraction,
  type SessionId,
} from '../src/index.js';
import { binding, collect, deferred, definition, FakeExecutor, flush } from './fake-executor.js';

const interaction: PendingInteraction = {
  interactionId: 'ask' as PendingInteraction['interactionId'],
  surfaceId: 'main',
  viewRevision: 'r1' as PendingInteraction['viewRevision'],
  component: 'tests.Question/v1',
  props: { title: 'Question' },
};
const sessionId = 'f03855d0-093d-44ef-afdd-58bff38d34dc' as SessionId;
const runtimes: Array<{ dispose(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
});

async function fixture(adopt = true) {
  const executor = new FakeExecutor();
  Object.assign(executor.features, { resume: true, checkpoints: true });
  executor.agent.pending = async () => interaction;
  const diagnostics: DiagnosticEvent[] = [];
  const runtime = createRuntime({
    appId: 'restore-tests',
    executors: [executor],
    diagnostics: (event) => diagnostics.push(event),
  });
  runtimes.push(runtime);
  const instance = await runtime.create(definition, {
    principalScope: 'user',
    agent: {},
    ...(adopt ? { sessionId } : {}),
  });
  return { executor, runtime, instance, diagnostics };
}

test('instances expose fresh sessions and adopt existing sessions for restore only', async () => {
  const fresh = await fixture(false);
  expect(fresh.instance.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  expect(fresh.instance.sessionId).not.toBe(sessionId);
  const { instance } = await fixture();
  expect(instance.sessionId).toBe(sessionId);
  await instance.prepare();
  await expect(instance.start('input')).rejects.toMatchObject({ code: 'invalid' });
  expect(instance.getSnapshot().run).toBeUndefined();
});

test.each([
  '',
  'session',
  sessionId.toUpperCase(),
  ` ${sessionId}`,
  `${sessionId}\n`,
  'f03855d0-093d-04ef-afdd-58bff38d34dc',
  'f03855d0-093d-44ef-7fdd-58bff38d34dc',
  null,
])('invalid session format rejects without disclosing it: %s', async (value) => {
  const { runtime } = await fixture();
  await expect(
    runtime.create(definition, {
      principalScope: 'user',
      agent: {},
      sessionId: value as SessionId,
    }),
  ).rejects.toMatchObject({
    code: 'invalid',
    message: 'The session ID is invalid.',
  });
});

test('an empty checkpoint leaves the run slot free for a fresh start', async () => {
  const { instance, executor } = await fixture(false);
  executor.agent.pending = async () => undefined;
  await instance.prepare();
  await expect(instance.restore()).resolves.toBeUndefined();
  expect(instance.getSnapshot().run).toBeUndefined();
  await instance.start('input');
  await flush();
  expect(instance.getSnapshot().run?.status).toBe('succeeded');
});

test('restore publishes once, replays the interaction, and dispatch resumes with conservative labels', async () => {
  const { instance, executor } = await fixture();
  await instance.prepare();
  const listener = vi.fn();
  instance.subscribe(listener);
  const pending = vi.spyOn(executor.agent, 'pending');
  const restored = await instance.restore();
  expect(restored).toBeDefined();
  if (restored === undefined) throw new Error('Expected a restored run.');
  const { runId } = restored;
  expect(listener).toHaveBeenCalledTimes(1);
  expect(instance.getSnapshot().run).toEqual({
    runId,
    status: 'waiting_input',
    pending: interaction,
    labels: ['app', 'private-user', 'public'],
  });
  expect(executor.requests).toEqual([]);
  const events = instance.events(runId)[Symbol.asyncIterator]();
  expect((await events.next()).value).toMatchObject({
    type: 'interaction',
    interaction,
    sequence: 0,
  });
  await events.return?.();
  await expect(
    instance.dispatch({
      instanceId: instance.instanceId,
      runId,
      ...interaction,
      action: 'submit',
      payload: false,
    }),
  ).resolves.toMatchObject({ status: 'accepted' });
  await collect(instance.events(runId));
  expect(pending.mock.calls).toEqual([[sessionId], [sessionId]]);
  expect(executor.requests[0]).toMatchObject({
    sessionId,
    command: {
      type: 'resume',
      interactionId: interaction.interactionId,
      action: 'submit',
      payload: false,
    },
  });
  expect(instance.getSnapshot().run?.status).toBe('succeeded');
});

test.each(['denied', 'unsupported'] as const)(
  'restore rejects %s before publishing props',
  async (code) => {
    const { instance, runtime, executor, diagnostics } = await fixture();
    const target =
      code === 'unsupported'
        ? await runtime.create(definition, {
            principalScope: 'user',
            agent: {},
            sessionId,
            ui: { components: {}, surfaces: ['main'] },
          })
        : instance;
    executor.agent.pending = async () => ({
      ...interaction,
      props:
        code === 'denied'
          ? { url: 'https://denied.example/private-props-canary' }
          : { text: 'private-props-canary' },
    });
    await target.prepare();
    await expect(target.restore()).rejects.toMatchObject({ code });
    expect(target.getSnapshot().run).toBeUndefined();
    expect(JSON.stringify(target.getSnapshot())).not.toContain('private-props-canary');
    expect(diagnostics).toContainEqual({
      kind: 'interaction_rejected',
      instanceId: target.instanceId,
    });
    expect(JSON.stringify(diagnostics)).not.toContain('private-props-canary');
  },
);

test('URL denial precedes UI rejection', async () => {
  const { runtime, executor } = await fixture();
  const instance = await runtime.create(definition, {
    principalScope: 'user',
    agent: {},
    ui: { components: {}, surfaces: [] },
  });
  executor.agent.pending = async () => ({
    ...interaction,
    props: { url: 'https://denied.example' },
  });
  await instance.prepare();
  await expect(instance.restore()).rejects.toMatchObject({ code: 'denied' });
});

test.each(['interrupts', 'resume', 'checkpoints'] as const)(
  'restore requires %s',
  async (feature) => {
    const { instance, executor } = await fixture();
    Object.assign(executor.features, { [feature]: false });
    const pending = vi.spyOn(executor.agent, 'pending');
    await instance.prepare();
    await expect(instance.restore()).rejects.toMatchObject({ code: 'unsupported' });
    expect(pending).not.toHaveBeenCalled();
    expect(instance.getSnapshot().run).toBeUndefined();
  },
);

test('restore requires ready state and rejects an active run', async () => {
  const { instance } = await fixture();
  await expect(instance.restore()).rejects.toMatchObject({ code: 'invalid' });
  await instance.prepare();
  await instance.restore();
  await expect(instance.restore()).rejects.toMatchObject({ code: 'invalid' });
  await instance.dispose();
  await expect(instance.restore()).rejects.toMatchObject({ code: 'invalid' });
});

test('restore claims the slot synchronously against both restore and start', async () => {
  const { instance, executor } = await fixture(false);
  const gate = deferred<PendingInteraction>();
  executor.agent.pending = () => gate.promise;
  await instance.prepare();
  const first = instance.restore();
  await expect(instance.restore()).rejects.toMatchObject({ code: 'invalid' });
  await expect(instance.start('input')).rejects.toMatchObject({ code: 'invalid' });
  gate.resolve(interaction);
  await expect(first).resolves.toBeDefined();
});

test('pending read failures use fixed dispatch-style errors, host-only diagnostics and release the slot', async () => {
  const { instance, executor, diagnostics } = await fixture();
  const raw = new GalaxieError('unavailable', 'private-pending-canary');
  executor.agent.pending = async () => {
    throw raw;
  };
  await instance.prepare();
  const failure = instance.restore();
  await expect(failure).rejects.not.toHaveProperty('cause');
  await expect(failure).rejects.toMatchObject({
    code: 'executor_error',
    message: 'The executor or agent code failed.',
  });
  expect(instance.getSnapshot().run).toBeUndefined();
  expect(diagnostics).toEqual([
    { kind: 'restore_failed', instanceId: instance.instanceId, error: raw },
  ]);
  executor.agent.pending = async () => interaction;
  await expect(instance.restore()).resolves.toBeDefined();
});

test('disposal waits for an in-flight restore and prevents late publication', async () => {
  const { instance, executor } = await fixture();
  const gate = deferred<PendingInteraction>();
  executor.agent.pending = () => gate.promise;
  await instance.prepare();
  const restoring = instance.restore();
  const rejected = expect(restoring).rejects.toMatchObject({ code: 'invalid' });
  const disposal = instance.dispose();
  await flush();
  expect(executor.disposeCalls).toBe(0);
  gate.resolve(interaction);
  await rejected;
  await disposal;
  expect(instance.getSnapshot().run).toBeUndefined();
});

test('restore validates grants and enforces private-user policy on free-text capabilities', async () => {
  const { runtime, executor } = await fixture();
  const invoke = vi.fn(async () => 'done');
  const instance = await runtime.create(
    {
      ...definition,
      capabilities: {
        optional: {
          'send@1': {
            kind: 'read',
            input: z.string().meta(galaxieField({ shape: 'freeText' })),
            output: z.string(),
          },
        },
      },
    },
    {
      principalScope: 'user',
      agent: {},
      sessionId,
      bindings: {
        'send@1': { ...binding({ destination: 'third-party', grantScope: 'run' }), invoke },
      },
    },
  );
  await instance.prepare();
  await expect(instance.restore({ grants: ['unknown@1'] })).rejects.toMatchObject({
    code: 'invalid',
  });
  const restored = await instance.restore({ grants: ['send@1'] });
  if (restored === undefined) throw new Error('Expected a restored run.');
  let failure: unknown;
  executor.scripts.push(async function* (request) {
    try {
      await request.capabilities.call('send@1', 'private-free-text');
    } catch (error) {
      failure = error;
    }
    yield { type: 'output', output: 'done' };
  });
  await instance.dispatch({
    instanceId: instance.instanceId,
    runId: restored.runId,
    ...interaction,
    action: 'submit',
    payload: null,
  });
  await collect(instance.events(restored.runId));
  expect(failure).toMatchObject({ code: 'denied' });
  expect(invoke).not.toHaveBeenCalled();
});
