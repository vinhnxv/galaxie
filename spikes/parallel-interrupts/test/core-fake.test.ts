// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readFile, writeFile } from 'node:fs/promises';
import {
  type AgentInstance,
  createRuntime,
  defineAgentDefinition,
  type InteractionId,
  type SessionId,
  type UserInteractionEvent,
} from '@galaxie-ai/core';
import { A2UI_SPEC_REVISION, A2UI_SPEC_VERSION } from '@galaxie-ai/ui-protocol';
import { afterAll, afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { MemoryRecoveryStore } from '../../../packages/core/test/support/memory-recovery-store.js';
import { FakeEngine, fakeState } from '../src/fake-engine.js';

const observations: Record<string, unknown> = {};
const disposables: Array<{ dispose(): Promise<void> }> = [];
const definition = defineAgentDefinition({
  id: 'spike/parallel-fake',
  version: '1.0.0',
  executor: 'parallel-spike-fake',
  input: z.string(),
});

afterEach(async () => {
  await Promise.all(disposables.splice(0).map((item) => item.dispose()));
});

afterAll(async () => {
  const url = new URL('../results/core.json', import.meta.url);
  let previous: Record<string, unknown> = {};
  try {
    previous = JSON.parse(await readFile(url, 'utf8'));
  } catch {
    /* First recording. */
  }
  await writeFile(url, `${JSON.stringify({ ...previous, C: observations }, null, 2)}\n`);
});

function probe(id: string, fn: () => Promise<unknown>): void {
  test(id, async () => {
    try {
      observations[id] = { pass: true, observation: await fn() };
    } catch (error) {
      observations[id] = {
        pass: false,
        observation: error instanceof Error ? error.message : 'Probe failed.',
      };
      throw error;
    }
  });
}

async function fixture(
  state = fakeState('twice'),
  recovery: MemoryRecoveryStore | undefined = new MemoryRecoveryStore(),
  sessionId?: SessionId,
  engine = new FakeEngine(state),
) {
  const runtime = createRuntime({ appId: 'parallel-spike', executors: [engine] });
  disposables.push(runtime);
  const instance = await runtime.create(definition, {
    principalScope: 'user',
    agent: {},
    ...(recovery === undefined ? {} : { recovery }),
    ...(sessionId === undefined ? {} : { sessionId }),
  });
  await instance.prepare();
  return { runtime, instance, engine, state, recovery };
}

async function waitForStatus(
  instance: AgentInstance<string, unknown>,
  status: string,
): Promise<void> {
  await vi.waitFor(() => expect(instance.getSnapshot().run?.status).toBe(status));
}

async function start(f: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  await f.instance.start('input');
  await waitForStatus(f.instance, 'waiting_input');
}

function event(instance: AgentInstance<string, unknown>, payload: unknown): UserInteractionEvent {
  const run = instance.getSnapshot().run;
  const pending = run?.pending;
  if (run === undefined || pending === undefined) throw new Error('Missing pending interaction.');
  return {
    instanceId: instance.instanceId,
    runId: run.runId,
    ...pending,
    action: 'submit',
    payload,
  };
}

async function answer(
  f: Awaited<ReturnType<typeof fixture>>,
  value: unknown,
  status: string,
): Promise<void> {
  expect(await f.instance.dispatch(event(f.instance, value))).toMatchObject({ status: 'accepted' });
  await waitForStatus(f.instance, status);
}

async function crashAndReopen(
  f: Awaited<ReturnType<typeof fixture>>,
  phase: 'beforeCommit' | 'afterCommit',
  value: unknown,
) {
  const sessionId = f.instance.sessionId;
  const gate = f.engine.gate(phase);
  expect(await f.instance.dispatch(event(f.instance, value))).toMatchObject({ status: 'accepted' });
  await gate.entered;
  gate.crash();
  await waitForStatus(f.instance, 'failed');
  await f.runtime.dispose();
  return fixture(f.state, f.recovery, sessionId);
}

probe('C1', async () => {
  const f = await fixture();
  await start(f);
  const published = [f.instance.getSnapshot().run?.pending?.interactionId];
  await answer(f, 'first-token', 'waiting_input');
  published.push(f.instance.getSnapshot().run?.pending?.interactionId);
  expect(published).toEqual(['r', 'r:1']);
  await answer(f, 'second-token', 'succeeded');
  expect(f.state.applied).toEqual([
    { id: 'r', payload: 'first-token' },
    { id: 'r:1', payload: 'second-token' },
  ]);
  return { published, applied: f.state.applied };
});

probe('C2', async () => {
  const f = await fixture();
  await start(f);
  const first = event(f.instance, 'first-token');
  const gate = f.engine.gate('beforeCommit');
  expect(await f.instance.dispatch(first)).toMatchObject({ status: 'accepted' });
  await gate.entered;
  expect(await f.instance.dispatch(first)).toMatchObject({ error: { code: 'duplicate' } });
  gate.release();
  await waitForStatus(f.instance, 'waiting_input');
  expect(f.instance.getSnapshot().run?.pending?.interactionId).toBe('r:1');
  expect(await f.instance.dispatch(first)).toMatchObject({ error: { code: 'duplicate' } });
  return {
    duringResume: 'duplicate',
    whileSecondPending: 'duplicate',
    firstApplications: f.state.applied.length,
  };
});

probe('C3', async () => {
  const f = await fixture();
  await start(f);
  const starts = f.state.starts;
  const premature = { ...event(f.instance, 'second-token'), interactionId: 'r:1' as InteractionId };
  expect(await f.instance.dispatch(premature)).toMatchObject({ error: { code: 'stale' } });
  expect(f.state.starts).toBe(starts);
  const divergent = fakeState('twice');
  const task = divergent.tasks[0];
  if (task === undefined) throw new Error('Missing task.');
  task.answers.push('first-token');
  const advertised = await fixture(divergent);
  await start(advertised);
  const next = event(advertised.instance, 'second-token');
  expect(next.interactionId).toBe('r:1');
  task.answers.pop();
  const segments = advertised.state.starts;
  expect(advertised.engine.pending()?.interactionId).toBe('r');
  expect(await advertised.instance.dispatch(next)).toMatchObject({ error: { code: 'stale' } });
  expect(advertised.state.starts).toBe(segments);
  return {
    committedPick: 'r',
    submitted: 'r:1',
    receipt: 'stale',
    extraSegments: 0,
    advertisedNextButCheckpointRolledBack: 'stale',
  };
});

probe('C4', async () => {
  const f = await fixture();
  await start(f);
  await answer(f, 'first-token', 'waiting_input');
  const restored = await crashAndReopen(f, 'beforeCommit', 'second-token');
  expect(await restored.instance.restore()).toBeDefined();
  await waitForStatus(restored.instance, 'succeeded');
  expect(restored.state.applied).toEqual([
    { id: 'r', payload: 'first-token' },
    { id: 'r:1', payload: 'second-token' },
  ]);
  return { window: 'accepted-before-commit', applied: restored.state.applied };
});

probe('C5', async () => {
  const f = await fixture();
  await start(f);
  await answer(f, 'first-token', 'waiting_input');
  const restored = await crashAndReopen(f, 'afterCommit', 'second-token');
  expect(await restored.instance.restore()).toBeUndefined();
  expect(restored.state.applied).toEqual([
    { id: 'r', payload: 'first-token' },
    { id: 'r:1', payload: 'second-token' },
  ]);
  const statuses = (await restored.recovery?.submissions(restored.instance.sessionId))?.map(
    (entry) => entry.status,
  );
  expect(statuses).toEqual(['consumed', 'consumed']);
  return { window: 'committed-before-publication', applied: restored.state.applied, statuses };
});

probe('C10', async () => {
  const surface = {
    format: 'galaxie.surface/1',
    region: 'main',
    a2uiSurfaceId: 'lesson',
    catalogId: 'spike/v1',
    revision: 1,
    specVersion: A2UI_SPEC_VERSION,
    specRevision: A2UI_SPEC_REVISION,
    status: 'live',
    components: { root: { id: 'root', component: 'Question' } },
    dataModel: {},
  };
  const parallel = fakeState(2);
  parallel.tasks[0] = { rawId: 'a', order: 0, requests: [surface], answers: [] };
  const multi = await fixture(parallel);
  await multi.instance.start('input');
  await waitForStatus(multi.instance, 'failed');
  expect(multi.instance.getSnapshot().run).toMatchObject({ error: { code: 'unsupported' } });
  expect(multi.instance.getSnapshot().run?.pending).toBeUndefined();
  const repeated = fakeState('twice');
  const first = repeated.tasks[0];
  if (first === undefined) throw new Error('Missing task.');
  repeated.tasks[0] = { ...first, requests: [first.requests[0], surface] };
  const ordinal = await fixture(repeated);
  await start(ordinal);
  await answer(ordinal, 'first-token', 'failed');
  expect(ordinal.instance.getSnapshot().run).toMatchObject({ error: { code: 'unsupported' } });
  expect(ordinal.instance.getSnapshot().run?.pending).toBeUndefined();
  return { twoPauseSet: 'unsupported', ordinalOne: 'unsupported', publishedSurfaceRecords: 0 };
});

probe('C6', async () => {
  const f = await fixture(fakeState(2));
  await start(f);
  const published = [f.instance.getSnapshot().run?.pending?.interactionId];
  await answer(f, 'a-token', 'waiting_input');
  published.push(f.instance.getSnapshot().run?.pending?.interactionId);
  await answer(f, 'b-token', 'succeeded');
  expect(published).toEqual(['a', 'b']);
  expect(f.state.applied).toEqual([
    { id: 'a', payload: 'a-token' },
    { id: 'b', payload: 'b-token' },
  ]);
  return { published, applied: f.state.applied };
});

probe('C7', async () => {
  const windows: unknown[] = [];
  for (const window of ['a', 'b', 'c'] as const) {
    const f = await fixture(fakeState(2));
    await start(f);
    if (window === 'c') await answer(f, 'a-token', 'waiting_input');
    const reopened = await crashAndReopen(
      f,
      window === 'b' ? 'afterCommit' : 'beforeCommit',
      window === 'c' ? 'b-token' : 'a-token',
    );
    expect(await reopened.instance.restore()).toBeDefined();
    if (window === 'a') await waitForStatus(reopened.instance, 'waiting_input');
    if (window !== 'c') await answer(reopened, 'b-token', 'succeeded');
    else await waitForStatus(reopened.instance, 'succeeded');
    expect(reopened.state.applied).toEqual([
      { id: 'a', payload: 'a-token' },
      { id: 'b', payload: 'b-token' },
    ]);
    windows.push({ window, applied: reopened.state.applied });
  }
  return { stablePick: true, windows };
});

probe('pick-order-negative-control', async () => {
  const f = await fixture(fakeState(2));
  await start(f);
  const reopened = await crashAndReopen(f, 'beforeCommit', 'a-token');
  reopened.state.reverseOrder = true;
  expect(await reopened.instance.restore()).toBeDefined();
  expect(reopened.instance.getSnapshot().run?.pending?.interactionId).toBe('b');
  const savedA = (await reopened.recovery?.submissions(reopened.instance.sessionId))?.find(
    (entry) => entry.interactionId === 'a',
  );
  expect(savedA?.status).toBe('consumed');
  expect(reopened.state.applied).toEqual([]);
  await answer(reopened, 'b-token', 'failed');
  expect(reopened.instance.getSnapshot().run?.error?.code).toBe('unsupported');
  return {
    changedPick: 'b',
    acceptedA: 'consumed-without-application',
    laterPublicationOfA: 'unsupported',
    applied: reopened.state.applied,
  };
});

probe('C8', async () => {
  const results: unknown[] = [];
  for (const durable of [false, true]) {
    const state = fakeState(2);
    const engine = new FakeEngine(state, async (task, request) => {
      if (task.rawId === 'b')
        await request.capabilities.call(
          'write@1',
          { token: 'prefix-token' },
          { effectScope: 'task:b' },
        );
    });
    let writes = 0;
    const store = new MemoryRecoveryStore();
    const runtime = createRuntime({ appId: 'parallel-confirm', executors: [engine] });
    disposables.push(runtime);
    const instance = await runtime.create(
      {
        ...definition,
        capabilities: {
          required: {
            'write@1': {
              kind: 'write',
              input: z.object({ token: z.string() }),
              output: z.string(),
            },
          },
        },
      },
      {
        principalScope: 'user',
        agent: {},
        ...(durable ? { recovery: store } : {}),
        bindings: {
          'write@1': {
            kind: 'write',
            destination: 'in-browser',
            timeoutMs: 1000,
            concurrency: 1,
            grantScope: 'instance',
            approval: 'confirm',
            retry: 'none',
            invoke: async () => {
              writes++;
              return 'receipt-token';
            },
          },
        },
        confirmations: { capabilities: ['write@1'], policyRevision: () => 'v1' },
      },
    );
    await instance.prepare();
    await instance.start('input');
    let confirmations = 0;
    let oldApprovalsRejectedAcrossExecutions = 0;
    const priorApprovals: Array<Parameters<typeof instance.respond>[0]> = [];
    const approveUntil = async (status: string): Promise<void> => {
      while (instance.getSnapshot().run?.status !== status) {
        await vi.waitFor(() =>
          expect(
            instance.getSnapshot().run?.status === status ||
              (instance.getSnapshot().confirmations?.length ?? 0) > 0,
          ).toBe(true),
        );
        const pending = instance.getSnapshot().confirmations?.[0];
        if (pending !== undefined) {
          confirmations++;
          expect(priorApprovals).not.toContain(pending.id);
          for (const old of priorApprovals) {
            expect(instance.respond(old, 'approve')).toEqual({ status: 'stale' });
            oldApprovalsRejectedAcrossExecutions++;
          }
          priorApprovals.push(pending.id);
          expect(instance.respond(pending.id, 'approve')).toEqual({ status: 'approved' });
          expect(instance.respond(pending.id, 'approve')).toEqual({ status: 'stale' });
        }
      }
    };
    await approveUntil('waiting_input');
    expect(await instance.dispatch(event(instance, 'a-token'))).toMatchObject({
      status: 'accepted',
    });
    await approveUntil('waiting_input');
    expect(await instance.dispatch(event(instance, 'b-token'))).toMatchObject({
      status: 'accepted',
    });
    await approveUntil('succeeded');
    expect(writes).toBe(durable ? 1 : 3);
    expect(confirmations).toBe(durable ? 1 : 3);
    results.push({
      recovery: durable,
      prefixExecutions: state.prefixes['b'],
      confirmations,
      writes,
      repeatedApproval: 'stale',
      oldApprovalsRejectedAcrossExecutions,
    });
  }
  return results;
});

probe('C9', async () => {
  const results: unknown[] = [];
  for (const branches of [2, 3]) {
    const f = await fixture(fakeState(branches));
    await start(f);
    for (let index = 0; index < branches; index++)
      await answer(f, `token-${index}`, index === branches - 1 ? 'succeeded' : 'waiting_input');
    const total = Object.values(f.state.prefixes).reduce((sum, count) => sum + count, 0);
    results.push({
      branches,
      prefixes: f.state.prefixes,
      totalIncludingInitial: total,
      resumeOnly: total - branches,
      estimate: (branches * (branches + 1)) / 2,
    });
  }
  return results;
});
