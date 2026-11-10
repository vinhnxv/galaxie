// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  type AgentInstance,
  createRuntime,
  defineAgentDefinition,
  type SessionId,
  type UserInteractionEvent,
} from '@galaxie-ai/core';
import { MemorySaver } from '@langchain/langgraph';
import { afterAll, afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { MemoryRecoveryStore } from '../../../packages/core/test/support/memory-recovery-store.js';
import { reopenSaver } from '../src/checkpoint-reader.js';
import { createFixture, DURABILITIES, type Durability, type FixtureKind } from '../src/graphs.js';
import { LangGraphExecutor } from '../src/langgraph-executor.js';
import { normalize, type Observation, writeEvidence } from './evidence.js';

const observations: Observation[] = [];
const runtimes: Array<{ dispose(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((r) => r.dispose()));
});
afterAll(() => writeEvidence('core', observations));
function probe(probe: string, run: (mode: Durability) => Promise<unknown>, pass = true): void {
  test.each(DURABILITIES)(`${probe} (%s)`, async (mode) => {
    observations.push({ probe, mode, pass, observation: normalize(await run(mode)) });
  });
}

const definition = defineAgentDefinition({
  id: 'spike/static-breakpoints',
  version: '1.0.0',
  executor: 'breakpoint-spike-langgraph',
  input: z.unknown(),
  capabilities: { optional: { 'write@1': { kind: 'write', input: z.null(), output: z.string() } } },
});

async function setup(
  kind: FixtureKind,
  mode: Durability,
  options: {
    saver?: MemorySaver;
    store?: MemoryRecoveryStore;
    noRecovery?: boolean;
    sessionId?: SessionId;
    node?: string;
    hook?: ConstructorParameters<typeof LangGraphExecutor>[4];
  } = {},
) {
  const saver = options.saver ?? new MemorySaver();
  const store = options.store ?? new MemoryRecoveryStore();
  const executor = new LangGraphExecutor(
    kind,
    saver,
    mode,
    options.node === undefined ? {} : { node: options.node },
    options.hook,
  );
  const runtime = createRuntime({
    appId: 'static-breakpoints',
    executors: [executor],
    urlAllowlist: ['https://allowed.example'],
  });
  runtimes.push(runtime);
  let writes = 0;
  const log: unknown[] = [];
  const instance = await runtime.create(definition, {
    principalScope: 'user',
    agent: {},
    ...(options.noRecovery ? {} : { recovery: store }),
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ui: {
      surfaces: ['breakpoint'],
      components: {
        'spike.Breakpoint/v1': {
          actions: { continue: { payload: z.null() }, reject: { payload: z.null() } },
        },
      },
    },
    bindings: {
      'write@1': {
        kind: 'write',
        destination: 'host-server',
        timeoutMs: 1000,
        concurrency: 1,
        grantScope: 'instance',
        approval: 'confirm',
        retry: 'none',
        invoke: async () => {
          writes++;
          return 'written';
        },
      },
    },
    confirmations: { capabilities: ['write@1'], policyRevision: () => 'v1' },
  });
  await instance.prepare();
  return { instance, executor, saver, store, runtime, writes: () => writes, log };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function status(instance: AgentInstance<unknown, unknown>, expected: string): Promise<void> {
  await vi.waitFor(() => expect(instance.getSnapshot().run?.status).toBe(expected), {
    interval: 1,
    timeout: 2000,
  });
}
function event(f: Fixture, action = 'continue', payload: unknown = null): UserInteractionEvent {
  const run = f.instance.getSnapshot().run;
  if (run?.pending === undefined) throw new Error('Missing pending interaction.');
  return { instanceId: f.instance.instanceId, runId: run.runId, ...run.pending, action, payload };
}
async function start(f: Fixture, expected = 'waiting_input', input: unknown = {}): Promise<void> {
  const { runId } = await f.instance.start(input);
  void (async () => {
    for await (const e of f.instance.events(runId)) f.log.push(e);
  })();
  await status(f.instance, expected);
}
async function answer(f: Fixture, action = 'continue', expected = 'succeeded'): Promise<void> {
  expect(await f.instance.dispatch(event(f, action))).toMatchObject({ status: 'accepted' });
  await status(f.instance, expected);
}
async function reload(f: Fixture, kind: FixtureKind, mode: Durability): Promise<Fixture> {
  await f.runtime.dispose();
  return setup(kind, mode, {
    saver: reopenSaver(f.saver, true),
    store: f.store,
    sessionId: f.instance.sessionId,
  });
}
async function events(f: Fixture): Promise<unknown[]> {
  const run = f.instance.getSnapshot().run;
  if (run === undefined) throw new Error('Missing run.');
  const items = [];
  for await (const e of f.instance.events(run.runId)) items.push(e);
  return [...f.log, ...items];
}

probe('CS1', async (mode) => {
  const f = await setup('before', mode);
  await start(f);
  const pending = f.instance.getSnapshot().run?.pending;
  expect(pending).toMatchObject({
    component: 'spike.Breakpoint/v1',
    props: { node: 'work', kind: 'before' },
  });
  expect(pending?.props).toEqual({ node: 'work', kind: 'before' });
  expect(await f.executor.pending(f.instance.sessionId)).toEqual(pending);
  expect(f.executor.counts).toEqual({ prepare: 1 });
  await answer(f);
  const log = await events(f);
  expect(log).toContainEqual(expect.objectContaining({ type: 'stream', mode: 'values' }));
  expect(log).toContainEqual(expect.objectContaining({ type: 'stream', mode: 'updates' }));
  return { pending, valuesAndUpdatesPreserved: true };
});
probe('CS2', async (mode) => {
  const f = await setup('before', mode);
  await start(f);
  await answer(f);
  expect(f.executor.counts).toEqual({ prepare: 1, work: 1, finish: 1 });
  const baseline = await createFixture('plain', new MemorySaver()).graph.invoke(
    {},
    { configurable: { thread_id: 'baseline' } },
  );
  expect(await events(f)).toContainEqual(
    expect.objectContaining({ type: 'output', output: baseline }),
  );
  return { counts: f.executor.counts, outputMatchesNative: true };
});
probe(
  'CS3',
  async (mode) => {
    const f = await setup('before', mode);
    await start(f);
    const pending = f.instance.getSnapshot().run?.pending;
    await answer(f, 'reject', 'failed');
    expect(f.instance.getSnapshot().run?.error?.code).toBe('denied');
    expect(f.instance.getSnapshot().run?.pending).toBeUndefined();
    expect(f.executor.counts['work'] ?? 0).toBe(0);
    const restored = await reload(f, 'before', mode);
    await restored.instance.restore();
    await status(restored.instance, 'failed');
    expect(restored.instance.getSnapshot().run?.error?.code).toBe('denied');
    expect(
      (await restored.store.submissions(restored.instance.sessionId)).map((s) => s.status),
    ).toEqual(['accepted']);
    const withoutInbox = await setup('before', mode, {
      saver: reopenSaver(f.saver),
      sessionId: f.instance.sessionId,
      noRecovery: true,
    });
    await withoutInbox.instance.restore();
    expect(withoutInbox.instance.getSnapshot().run?.pending).toEqual(pending);
    const snapshot = restored.instance.getSnapshot();
    const restarted = await setup('before', mode);
    await start(restarted);
    await answer(restarted, 'reject', 'failed');
    await start(restarted);
    expect(restarted.executor.counts['prepare']).toBe(2);
    return {
      liveError: 'denied',
      workExecutions: 0,
      noInboxRestoreRepublishes: true,
      inboxRemainsAccepted: true,
      pendingOnRestore: snapshot.run?.pending,
      restoredError: snapshot.run?.error?.code,
      sameCheckpointPause:
        (await restored.executor.pending(restored.instance.sessionId))?.interactionId ===
        pending?.interactionId,
      newStartPrepareExecutions: restarted.executor.counts['prepare'],
    };
  },
  false,
);
probe(
  'CS4',
  async (mode) => {
    const f = await setup('after', mode);
    await start(f, 'failed');
    expect(f.instance.getSnapshot().run?.error?.code).toBe('unsupported');
    return {
      outcome: 'refused',
      reason: 'No finished-node derivation implemented across all modes.',
      counts: f.executor.counts,
    };
  },
  false,
);
probe('CS5', async (mode) => {
  const f = await setup('before', mode);
  await start(f);
  const old = event(f);
  const pending = f.instance.getSnapshot().run?.pending;
  const r = await reload(f, 'before', mode);
  const restored = await r.instance.restore();
  expect(r.instance.getSnapshot().run?.pending).toEqual(pending);
  expect(await r.instance.dispatch({ ...old, instanceId: r.instance.instanceId })).toMatchObject({
    error: { code: 'stale' },
  });
  const accepted = { ...old, instanceId: r.instance.instanceId, runId: restored!.runId };
  expect(await r.instance.dispatch(accepted)).toMatchObject({ status: 'accepted' });
  await status(r.instance, 'succeeded');
  expect(await r.instance.dispatch(accepted)).toMatchObject({ error: { code: 'duplicate' } });
  expect(r.executor.counts).toEqual({ work: 1, finish: 1 });
  return {
    identicalPending: true,
    oldRun: 'stale',
    restoredAnswer: 'accepted',
    repeatedAnswer: 'duplicate',
    counts: r.executor.counts,
  };
});

async function crashWindows(
  kind: 'before' | 'gate' | 'strippedNamespace',
  mode: Durability,
  action: string,
): Promise<unknown[]> {
  const observations = [];
  for (const fault of ['beforeResume', 'afterCommit', undefined] as const) {
    const f = await setup(kind, mode);
    await start(f);
    f.executor.fault = fault;
    await answer(
      f,
      action,
      fault !== undefined || (kind === 'before' && action === 'reject') ? 'failed' : 'succeeded',
    );
    const beforeCounts = { ...f.executor.counts };
    const r = await reload(f, kind, mode);
    const restored = await r.instance.restore();
    await vi.waitFor(() => expect(r.instance.getSnapshot().run?.status === 'running').toBe(false), {
      interval: 1,
    });
    if (kind !== 'before' || action !== 'reject') {
      if (fault === 'beforeResume') {
        expect(restored).toBeDefined();
        await status(r.instance, 'succeeded');
      } else {
        expect(restored).toBeUndefined();
        expect(r.instance.getSnapshot().run).toBeUndefined();
      }
      expect(
        await r.executor.pending(r.instance.sessionId, { registerRestoredData: () => {} }),
      ).toBeUndefined();
      if (kind !== 'before')
        expect((beforeCounts['gate'] ?? 0) + (r.executor.counts['gate'] ?? 0)).toBe(2);
      expect((beforeCounts['work'] ?? 0) + (r.executor.counts['work'] ?? 0)).toBe(
        kind === 'strippedNamespace' || action === 'reject' ? 0 : 1,
      );
      expect((await r.store.submissions(r.instance.sessionId)).map((s) => s.status)).toEqual([
        'consumed',
      ]);
    } else expect((beforeCounts['work'] ?? 0) + (r.executor.counts['work'] ?? 0)).toBe(0);
    observations.push({
      fault: fault ?? 'none',
      beforeCounts,
      afterCounts: r.executor.counts,
      restoredStatus: r.instance.getSnapshot().run?.status ?? 'no pending run',
      restoredError: r.instance.getSnapshot().run?.error?.code,
      checkpointStillPending:
        (await r.executor.pending(r.instance.sessionId, { registerRestoredData: () => {} })) !==
        undefined,
      inbox: (await r.store.submissions(r.instance.sessionId)).map(({ status }) => status),
    });
  }
  return observations;
}
probe('CS6-continue', (mode) => crashWindows('before', mode, 'continue'));
probe('CS6-reject', (mode) => crashWindows('before', mode, 'reject'), false);
probe('CS7', async (mode) => {
  const f = await setup('before', mode);
  await start(f);
  const original = event(f);
  expect(
    await f.instance.dispatch({
      ...original,
      interactionId: 'wrong' as typeof original.interactionId,
    }),
  ).toMatchObject({ error: { code: 'stale' } });
  expect(await f.instance.dispatch({ ...original, action: 'approve' })).toMatchObject({
    error: { code: 'invalid' },
  });
  expect(await f.instance.dispatch({ ...original, payload: 'non-null' })).toMatchObject({
    error: { code: 'invalid' },
  });
  await answer(f);
  expect(await f.instance.dispatch(original)).toMatchObject({ error: { code: 'duplicate' } });
  return { wrongId: 'stale', unknownAction: 'invalid', nonNull: 'invalid', repeated: 'duplicate' };
});
probe('CS8', async (mode) => {
  const refused = [];
  for (const kind of ['fanoutBoth', 'child', 'failing'] as const) {
    const f = await setup(kind, mode);
    await start(f, 'failed');
    expect(f.instance.getSnapshot().run).toMatchObject({ error: { code: 'unsupported' } });
    expect(f.instance.getSnapshot().run?.pending).toBeUndefined();
    refused.push({ kind, error: 'unsupported', noPublishedPause: true });
  }
  return refused;
});
probe('CS9', async (mode) => {
  const f = await setup('loop', mode);
  await start(f);
  const first = event(f);
  await answer(f, 'continue', 'waiting_input');
  const second = event(f);
  expect(second.interactionId).not.toBe(first.interactionId);
  expect(await f.instance.dispatch(first)).toMatchObject({ error: { code: 'duplicate' } });
  await answer(f);
  expect(f.executor.counts['work']).toBe(2);
  return { ids: [first.interactionId, second.interactionId], workExecutions: 2 };
});
probe('CS10', async (mode) => {
  const canary = 'private-state-canary-unique';
  const f = await setup('before', mode);
  await start(f, 'waiting_input', { privateValue: canary });
  expect(JSON.stringify(f.instance.getSnapshot())).not.toContain(canary);
  await answer(f);
  const log = await events(f);
  expect(
    JSON.stringify(
      log.filter(
        (e) =>
          (e as { type: string }).type !== 'stream' && (e as { type: string }).type !== 'output',
      ),
    ),
  ).not.toContain(canary);
  expect(JSON.stringify(log.filter((e) => (e as { type: string }).type === 'stream'))).toContain(
    canary,
  );
  const refused = [];
  for (const node of ['<script>', 'https://evil.example', 'x'.repeat(65)]) {
    try {
      const unsafe = await setup('before', mode, { node });
      await start(unsafe, 'failed');
      expect(unsafe.instance.getSnapshot().run?.error?.code).toBe('unsupported');
      expect(unsafe.instance.getSnapshot().run?.pending).toBeUndefined();
      refused.push({ node, refusal: 'unsupported' });
    } catch (error) {
      if (!node.includes(':')) throw error;
      expect((error as Error).message).toContain('reserved');
      refused.push({ node, refusal: 'native node-name validation before compilation' });
    }
  }
  return {
    noCanaryInSnapshotOrInteractionEvents: true,
    nativeStreamsAndUnprojectedOutputContainState: true,
    refused,
  };
});
probe('CS11', async (mode) => {
  const f = await setup('before', mode, {
    hook: async (name, _config, request) => {
      if (name === 'work') await request.capabilities.call('write@1', null);
    },
  });
  await start(f);
  const before = event(f);
  expect(await f.instance.dispatch(before)).toMatchObject({ status: 'accepted' });
  await vi.waitFor(() => expect(f.instance.getSnapshot().confirmations).toHaveLength(1));
  expect(f.writes()).toBe(0);
  const id = f.instance.getSnapshot().confirmations![0]!.id;
  expect(f.instance.respond(id, 'approve')).toEqual({ status: 'approved' });
  expect(f.instance.respond(id, 'approve')).toEqual({ status: 'stale' });
  await status(f.instance, 'succeeded');
  expect(f.writes()).toBe(1);
  expect(await f.instance.dispatch(before)).toMatchObject({ error: { code: 'duplicate' } });
  return {
    continueDidNotApprove: true,
    writesBeforeApproval: 0,
    writesAfterApproval: 1,
    reusedApproval: 'stale',
  };
});
probe('CS12', async (mode) => {
  const f = await setup('dynamic', mode);
  await start(f);
  const config = { configurable: { thread_id: f.instance.sessionId } };
  const tuple = await f.saver.getTuple(config);
  const taskId = (await f.executor.graph.getState(config)).tasks[0]!.id;
  const value = { action: 'continue', payload: null };
  await f.saver.putWrites(tuple!.config, [['__resume__', [value]]], taskId);
  const registrations: unknown[] = [];
  expect(
    await f.executor.pending(f.instance.sessionId, {
      registerRestoredData: (v) => {
        registrations.push(v);
      },
    }),
  ).toBeDefined();
  expect(registrations).toEqual([value]);
  await expect(f.executor.pending(f.instance.sessionId)).rejects.toMatchObject({
    code: 'unsupported',
  });
  return { registeredBeforePending: registrations, missingHook: 'unsupported' };
});
probe('CR1', async (mode) => {
  const result = [];
  for (const action of ['continue', 'reject']) {
    const f = await setup('gate', mode);
    await start(f);
    const pending = f.instance.getSnapshot().run?.pending;
    expect(pending?.interactionId).not.toContain('breakpoint:');
    const r = await reload(f, 'gate', mode);
    await r.instance.restore();
    expect(r.instance.getSnapshot().run?.pending).toEqual(pending);
    await answer(r, action);
    expect(r.executor.counts['work'] ?? 0).toBe(action === 'continue' ? 1 : 0);
    result.push({
      action,
      counts: r.executor.counts,
      crashWindows: await crashWindows('gate', mode, action),
    });
  }
  return {
    replacement: 'explicit requestInteraction gate and conditional END edge',
    results: result,
  };
});
probe('CR2', async (mode) => {
  const f = await setup('dynamic', mode);
  await start(f);
  const r = await reload(f, 'dynamic', mode);
  await r.instance.restore();
  await answer(r);
  return { publishesResumesAndRestores: true, counts: r.executor.counts };
});
probe('CI1', async (mode) => {
  for (const kind of ['nodeInterrupt', 'rawInterrupt', 'strippedSend'] as const) {
    const f = await setup(kind, mode);
    await start(f, 'failed');
    expect(f.instance.getSnapshot().run?.error?.code).toBe('unsupported');
    expect(f.instance.getSnapshot().run?.pending).toBeUndefined();
  }
  return {
    nodeInterrupt: 'unsupported',
    rawInterrupt: 'unsupported',
    parallelMissingIds: 'unsupported',
  };
});
probe('CI2', async (mode) => {
  const f = await setup('strippedNamespace', mode);
  await start(f);
  const pending = f.instance.getSnapshot().run?.pending;
  expect(pending?.interactionId).toMatch(/^idless:/);
  const r = await reload(f, 'strippedNamespace', mode);
  await r.instance.restore();
  expect(r.instance.getSnapshot().run?.pending).toEqual(pending);
  await answer(r);
  expect(r.executor.counts['gate']).toBe(1);
  expect(await events(r)).toContainEqual(
    expect.objectContaining({
      type: 'output',
      output: expect.objectContaining({ answer: { action: 'continue', payload: null } }),
    }),
  );
  return {
    synthesizedPending: pending,
    restoredAndAppliedOnce: true,
    crashWindows: await crashWindows('strippedNamespace', mode, 'continue'),
  };
});
