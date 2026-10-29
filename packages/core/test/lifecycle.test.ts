// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test, vi } from 'vitest';
import {
  createRuntime,
  type DiagnosticEvent,
  EFFECT_TRANSITIONS,
  GalaxieError,
  INSTANCE_TRANSITIONS,
  type InteractionId,
  type PendingInteraction,
  RUN_TRANSITIONS,
  type SessionId,
  type Transitions,
  type ViewRevision,
} from '../src/index.js';
import { deferred, definition, FakeExecutor, flush, type Script } from './fake-executor.js';
import { MemoryRecoveryStore } from './support/memory-recovery-store.js';

const TABLES: ReadonlyArray<readonly [string, Transitions<string>]> = [
  ['instance', INSTANCE_TRANSITIONS],
  ['run', RUN_TRANSITIONS],
  ['effect', EFFECT_TRANSITIONS],
];

function terminalStates(table: Transitions<string>): Set<string> {
  return new Set(Object.keys(table).filter((state) => table[state]?.length === 0));
}

function reachableFrom(table: Transitions<string>, start: string): Set<string> {
  const reached = new Set([start]);
  // A Set iterator also visits the entries added while it runs.
  for (const state of reached) {
    for (const next of table[state] ?? []) {
      reached.add(next);
    }
  }
  return reached;
}

test.each(TABLES)('every %s state can reach a terminal state', (_name, table) => {
  const terminal = terminalStates(table);
  for (const state of Object.keys(table)) {
    expect([...reachableFrom(table, state)].some((reached) => terminal.has(reached))).toBe(true);
  }
});

describe('instance transitions', () => {
  test('dispose can start from every state before disposing', () => {
    for (const state of ['created', 'preparing', 'ready'] as const) {
      expect(INSTANCE_TRANSITIONS[state]).toContain('disposing');
    }
  });
});

describe('run transitions', () => {
  test('a queued run can fail while waiting for settlement', () => {
    expect(RUN_TRANSITIONS.queued).toContain('failed');
  });
  test('a run ends as succeeded, failed or cancelled', () => {
    expect(terminalStates(RUN_TRANSITIONS)).toEqual(new Set(['succeeded', 'failed', 'cancelled']));
  });

  test('a run can be cancelled from every state that is not terminal', () => {
    for (const next of Object.values(RUN_TRANSITIONS)) {
      if (next.length > 0) {
        expect(next).toContain('cancelled');
      }
    }
  });
});

describe('effect transitions', () => {
  test('no transition leads back to planned, so an effect keeps its ID', () => {
    for (const next of Object.values(EFFECT_TRANSITIONS)) {
      expect(next).not.toContain('planned');
    }
  });
});

const pending: PendingInteraction = {
  interactionId: 'lifecycle-question' as InteractionId,
  surfaceId: 'main',
  viewRevision: 'r1' as ViewRevision,
  component: 'tests.Question/v1',
  props: {},
};
function marked(): Error {
  return Object.assign(new Error('private-storage-canary'), { unrecoverable: true });
}
async function lifecycleFixture(
  store?: MemoryRecoveryStore,
  sessionId?: SessionId,
  scripts: Script[] = [],
) {
  const executor = new FakeExecutor(scripts);
  Object.assign(executor.features, { resume: true, checkpoints: true });
  executor.agent.pending = async () => pending;
  const diagnostics: DiagnosticEvent[] = [];
  const runtime = createRuntime({
    appId: 'lifecycle-tests',
    executors: [executor],
    diagnostics: (event) => diagnostics.push(event),
  });
  const instance = await runtime.create(definition, {
    principalScope: 'user',
    agent: {},
    ...(store === undefined ? {} : { recovery: store }),
    ...(sessionId === undefined ? {} : { sessionId }),
  });
  await instance.prepare();
  return { runtime, instance, executor, diagnostics };
}

describe('storage outcomes', () => {
  test('maps a marked pending read failure without exposing host text', async () => {
    const fixture = await lifecycleFixture();
    const error = marked();
    fixture.executor.agent.pending = async () => {
      throw error;
    };
    await expect(fixture.instance.restore()).rejects.toMatchObject({
      code: 'unrecoverable',
      message: 'Stored state cannot be recovered.',
    });
    expect(fixture.instance.getSnapshot().run).toBeUndefined();
    expect(fixture.diagnostics).toContainEqual(
      expect.objectContaining({ kind: 'restore_failed', error }),
    );
    await fixture.runtime.dispose();
  });

  test.each([false, true])('maps a marked run error, wrapped=%s', async (wrapped) => {
    const original = marked();
    const error = wrapped
      ? new GalaxieError('executor_error', 'private-wrapper-canary', { cause: original })
      : Object.assign(original, { code: 'executor_error' });
    const fixture = await lifecycleFixture(undefined, undefined, [
      [{ type: 'error', error: error as GalaxieError }],
    ]);
    const { runId } = await fixture.instance.start('input');
    await flush();
    expect(fixture.instance.getSnapshot().run?.error).toMatchObject({
      code: 'unrecoverable',
      message: 'Stored state cannot be recovered.',
    });
    const events = [];
    for await (const event of fixture.instance.events(runId)) events.push(event);
    expect(JSON.stringify([events, fixture.instance.getSnapshot()])).not.toContain('private-');
    expect(fixture.diagnostics).toContainEqual(
      expect.objectContaining({ kind: 'run_failed', error: original }),
    );
    await fixture.runtime.dispose();
  });

  test('ignores inherited unrecoverable markers', async () => {
    const error = Object.create({ unrecoverable: true });
    const fixture = await lifecycleFixture();
    fixture.executor.agent.pending = async () => {
      throw error;
    };
    await expect(fixture.instance.restore()).rejects.toMatchObject({ code: 'executor_error' });
    await fixture.runtime.dispose();
  });

  test.each(['pending', 'store'] as const)(
    'maps a marked dispatch %s failure and leaves the interaction pending',
    async (location) => {
      const store = new MemoryRecoveryStore();
      const fixture = await lifecycleFixture(store, undefined, [
        [{ type: 'interaction', interaction: pending }],
      ]);
      const { runId } = await fixture.instance.start('input');
      await flush();
      const error = marked();
      if (location === 'pending')
        fixture.executor.agent.pending = async () => {
          throw error;
        };
      else
        store.acceptSubmission = async () => {
          throw error;
        };
      const receipt = await fixture.instance.dispatch({
        instanceId: fixture.instance.instanceId,
        runId,
        ...pending,
        action: 'submit',
        payload: false,
      });
      expect(receipt).toMatchObject({ status: 'rejected', error: { code: 'unrecoverable' } });
      expect(JSON.stringify(receipt)).not.toContain('private-storage-canary');
      expect(fixture.instance.getSnapshot().run?.status).toBe('waiting_input');
      expect(fixture.executor.requests).toHaveLength(1);
      await fixture.runtime.dispose();
    },
  );
});

describe('session agent version', () => {
  test('records the agent identity durably before publishing or starting a segment', async () => {
    const store = new MemoryRecoveryStore();
    const gate = deferred<void>();
    const record = store.recordSession.bind(store);
    store.recordSession = async (...args) => {
      await gate.promise;
      return record(...args);
    };
    const fixture = await lifecycleFixture(store);
    const start = fixture.instance.start('input');
    await flush();
    expect(fixture.executor.requests).toHaveLength(0);
    expect(fixture.instance.getSnapshot().run).toBeUndefined();
    gate.resolve();
    await start;
    expect(await store.session(fixture.instance.sessionId)).toEqual({
      agentId: definition.id,
      agentVersion: definition.version,
    });
    await fixture.runtime.dispose();
  });

  test('fails start with unavailable and frees the slot after a record failure', async () => {
    const store = new MemoryRecoveryStore();
    const fixture = await lifecycleFixture(store);
    const fail = vi.spyOn(store, 'recordSession').mockRejectedValueOnce(marked());
    await expect(fixture.instance.start('input')).rejects.toMatchObject({
      code: 'unavailable',
      message: 'The requested service is unavailable.',
    });
    expect(fixture.instance.getSnapshot().run).toBeUndefined();
    expect(fixture.executor.requests).toHaveLength(0);
    fail.mockRestore();
    await fixture.instance.start('input');
    await fixture.runtime.dispose();
  });

  test('refuses to start when the store returns a different existing identity', async () => {
    const store = new MemoryRecoveryStore();
    const fixture = await lifecycleFixture(store);
    await store.recordSession(fixture.instance.sessionId, {
      agentId: definition.id,
      agentVersion: '2.0.0',
    });
    await expect(fixture.instance.start('input')).rejects.toMatchObject({ code: 'unavailable' });
    expect(fixture.instance.getSnapshot().run).toBeUndefined();
    expect(fixture.executor.requests).toHaveLength(0);
    expect(await store.session(fixture.instance.sessionId)).toEqual({
      agentId: definition.id,
      agentVersion: '2.0.0',
    });
    await fixture.runtime.dispose();
  });

  test.each([
    undefined,
    { agentId: 'tests/other', agentVersion: '1.0.0' },
    { agentId: definition.id, agentVersion: '2.0.0' },
  ])('refuses missing or incompatible metadata before reading pending: %j', async (record) => {
    const store = new MemoryRecoveryStore();
    const sessionId = crypto.randomUUID() as SessionId;
    if (record !== undefined) await store.recordSession(sessionId, record);
    const fixture = await lifecycleFixture(store, sessionId);
    const read = vi.spyOn(fixture.executor.agent, 'pending');
    await expect(fixture.instance.restore()).rejects.toMatchObject({
      code: 'unsupported',
      message: 'The saved session uses an unsupported agent version.',
    });
    expect(read).not.toHaveBeenCalled();
    expect(fixture.instance.getSnapshot().run).toBeUndefined();
    expect(fixture.diagnostics).toContainEqual(expect.objectContaining({ kind: 'restore_failed' }));
    expect(await store.session(sessionId)).toEqual(record);
    await fixture.runtime.dispose();
  });

  test('maps marked submission reads after a compatible version check', async () => {
    const store = new MemoryRecoveryStore();
    const sessionId = crypto.randomUUID() as SessionId;
    await store.recordSession(sessionId, {
      agentId: definition.id,
      agentVersion: definition.version,
    });
    const fixture = await lifecycleFixture(store, sessionId);
    store.submissions = async () => {
      throw marked();
    };
    await expect(fixture.instance.restore()).rejects.toMatchObject({ code: 'unrecoverable' });
    expect(fixture.instance.getSnapshot().run).toBeUndefined();
    await fixture.runtime.dispose();
  });

  test.each([
    null,
    {},
    { agentId: 5, agentVersion: '1.0.0' },
    { agentId: definition.id, agentVersion: '1.0.0', extra: 'private-version-canary' },
  ])('refuses malformed session metadata without publication: %j', async (record) => {
    const store = new MemoryRecoveryStore();
    store.session = async () => record as never;
    const fixture = await lifecycleFixture(store);
    await expect(fixture.instance.restore()).rejects.toMatchObject({
      code: 'unrecoverable',
      message: 'Stored state cannot be recovered.',
    });
    expect(fixture.instance.getSnapshot().run).toBeUndefined();
    await fixture.runtime.dispose();
  });

  test('maps a marked session read failure to unrecoverable', async () => {
    const store = new MemoryRecoveryStore();
    const fixture = await lifecycleFixture(store);
    const error = marked();
    store.session = async () => {
      throw error;
    };
    await expect(fixture.instance.restore()).rejects.toMatchObject({ code: 'unrecoverable' });
    expect(fixture.instance.getSnapshot().run).toBeUndefined();
    expect(fixture.diagnostics).toContainEqual(
      expect.objectContaining({ kind: 'restore_failed', error }),
    );
    await fixture.runtime.dispose();
  });
});
