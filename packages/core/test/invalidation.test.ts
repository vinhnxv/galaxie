// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { watchInvalidation } from '@galaxie/core/browser';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import {
  createRuntime,
  GalaxieError,
  type InteractionId,
  type PendingInteraction,
  type Runtime,
  toErrorInfo,
  type ViewRevision,
} from '../src/index.js';
import { binding, definition, FakeExecutor, type Script } from './fake-executor.js';
import { MemoryRecoveryStore } from './support/memory-recovery-store.js';

const watchers: Array<{ close(): void }> = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const watcher of watchers.splice(0)) watcher.close();
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
});
function watch(appId: string, principalScope = 'user'): ReturnType<typeof watchInvalidation> {
  const watcher = watchInvalidation({ appId, principalScope });
  watchers.push(watcher);
  return watcher;
}
describe('cross-tab invalidation', () => {
  test('announces locally and to a peer while ignoring other principals and malformed notices', async () => {
    const appId = crypto.randomUUID();
    const a = watch(appId);
    const b = watch(appId);
    const other = watch(appId, 'other');
    const channel = new BroadcastChannel(`galaxie:${appId}:invalidation`);
    watchers.push(channel);
    for (const value of [
      null,
      {},
      { v: 2, type: 'invalidated', principalScope: 'user' },
      { v: 1, type: 'invalidated', principalScope: 'user', text: 'private' },
      { v: 1, type: 'handover', principalScope: 'user' },
      { v: 1, type: 'invalidated', principalScope: 'other' },
    ])
      channel.postMessage(value);
    await vi.waitFor(() => expect(other.signal.aborted).toBe(true));
    expect(a.signal.aborted).toBe(false);
    expect(b.signal.aborted).toBe(false);
    a.announce();
    expect(a.signal.reason).toBe('invalidated');
    await vi.waitFor(() => expect(b.signal.reason).toBe('invalidated'));
    a.close();
    a.close();
  });
  test('close is idempotent and stops receiving messages', async () => {
    const appId = crypto.randomUUID();
    const a = watch(appId);
    const closed = watch(appId);
    const peer = watch(appId);
    closed.close();
    closed.close();
    a.announce();
    await vi.waitFor(() => expect(peer.signal.aborted).toBe(true));
    expect(closed.signal.aborted).toBe(false);
  });
  test.each(['', 'private user', 'x'.repeat(129)])('rejects invalid IDs: %s', (id) => {
    expect(() => watchInvalidation({ appId: id, principalScope: 'user' })).toThrowError(
      expect.objectContaining({ code: 'invalid' }),
    );
    expect(() => watchInvalidation({ appId: 'app', principalScope: id })).toThrowError(
      expect.objectContaining({ code: 'invalid' }),
    );
  });
  test('requires BroadcastChannel', () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    expect(() => watch('app')).toThrowError(expect.objectContaining({ code: 'unsupported' }));
  });
});

const pending: PendingInteraction = {
  interactionId: 'question' as InteractionId,
  surfaceId: 'main',
  viewRevision: 'r1' as ViewRevision,
  component: 'tests.Question/v1',
  props: {},
};
const invalidated = (): Error =>
  Object.assign(new Error('private-storage-canary'), {
    invalidated: true,
    fenced: true,
    unrecoverable: true,
  });
async function fixture(store = new MemoryRecoveryStore(), scripts: Script[] = []) {
  const executor = new FakeExecutor(scripts);
  Object.assign(executor.features, { resume: true, checkpoints: true });
  executor.agent.pending = async () => pending;
  const runtime = createRuntime({ appId: 'invalidation-tests', executors: [executor] });
  runtimes.push(runtime);
  const instance = await runtime.create(
    {
      ...definition,
      capabilities: {
        optional: {
          'write@1': { input: z.string(), output: z.string(), kind: 'write' },
        },
      },
    },
    {
      principalScope: 'user',
      agent: {},
      recovery: store,
      bindings: {
        'write@1': { ...binding({ kind: 'write' }), invoke: async (input: string) => input },
      },
    },
  );
  await instance.prepare();
  await store.recordSession(instance.sessionId, {
    agentId: definition.id,
    agentVersion: definition.version,
    executorId: 'fake',
  });
  return { instance, executor, store };
}
describe('invalidated storage outcomes', () => {
  test.each(['pending', 'session', 'inbox', 'consume'] as const)(
    'maps restore %s failures to stale',
    async (phase) => {
      const f = await fixture();
      const fail = async (): Promise<never> => {
        throw invalidated();
      };
      if (phase === 'pending') f.executor.agent.pending = fail;
      else if (phase === 'session') f.store.session = fail;
      else if (phase === 'inbox') f.store.submissions = fail;
      else {
        await f.store.acceptSubmission(f.instance.sessionId, {
          interactionId: 'resolved',
          action: 'submit',
          payload: false,
        });
        f.store.consumeSubmission = fail;
      }
      await expect(f.instance.restore()).rejects.toMatchObject({
        code: 'stale',
        message: toErrorInfo('stale').message,
      });
      expect(f.instance.getSnapshot().run).toBeUndefined();
    },
  );
  test('maps session creation failures without a cause', async () => {
    const f = await fixture();
    f.store.recordSession = async () => {
      throw invalidated();
    };
    await expect(f.instance.start('input')).rejects.toMatchObject({ code: 'stale' });
  });
  test.each([false, true])('maps run errors including adapter wrapping: %s', async (wrapped) => {
    const original = invalidated();
    const error = wrapped
      ? new GalaxieError('executor_error', 'private-wrapper', { cause: original })
      : Object.assign(original, { code: 'executor_error' });
    const f = await fixture(undefined, [[{ type: 'error', error: error as GalaxieError }]]);
    await f.instance.start('input');
    await vi.waitFor(() => expect(f.instance.getSnapshot().run?.error?.code).toBe('stale'));
    expect(JSON.stringify(f.instance.getSnapshot())).not.toContain('private-');
  });
  test.each(['pending', 'store'] as const)('maps dispatch %s failures', async (phase) => {
    const f = await fixture(undefined, [[{ type: 'interaction', interaction: pending }]]);
    const { runId } = await f.instance.start('input');
    await vi.waitFor(() => expect(f.instance.getSnapshot().run?.status).toBe('waiting_input'));
    const fail = async (): Promise<never> => {
      throw invalidated();
    };
    if (phase === 'pending') f.executor.agent.pending = fail;
    else f.store.acceptSubmission = fail;
    expect(
      await f.instance.dispatch({
        instanceId: f.instance.instanceId,
        runId,
        ...pending,
        action: 'submit',
        payload: false,
      }),
    ).toMatchObject({ status: 'rejected', error: { code: 'stale' } });
  });
  test.each(['read', 'planned', 'dispatched', 'succeeded'] as const)(
    'rejects invalidated journal %s failures, even after invoke',
    async (phase) => {
      const store = new MemoryRecoveryStore();
      const record = store.recordEffect.bind(store);
      if (phase === 'read')
        store.effect = async () => {
          throw invalidated();
        };
      else
        store.recordEffect = async (...args) => {
          if (args[2].status === phase) throw invalidated();
          await record(...args);
        };
      const errors: unknown[] = [];
      const f = await fixture(store, [
        async function* (request) {
          try {
            yield {
              type: 'output',
              output: await request.capabilities.call('write@1', 'private reply'),
            };
          } catch (error) {
            errors.push(error);
            yield { type: 'error', error: toErrorInfo((error as GalaxieError).code) };
          }
        },
      ]);
      await store.acceptSubmission(f.instance.sessionId, {
        interactionId: pending.interactionId,
        action: 'submit',
        payload: false,
      });
      await f.instance.restore();
      await vi.waitFor(() => expect(f.instance.getSnapshot().run?.status).toBe('failed'));
      expect(errors[0]).toMatchObject({ code: 'stale', message: toErrorInfo('stale').message });
      expect(errors[0]).not.toHaveProperty('cause');
      expect(JSON.stringify(f.instance.getSnapshot())).not.toContain('private-storage-canary');
      expect(JSON.stringify(f.instance.getSnapshot())).not.toContain('private reply');
    },
  );
  test.each(['read', 'succeeded'] as const)(
    'preserves stale when an executor propagates a sanitized journal %s failure',
    async (phase) => {
      const store = new MemoryRecoveryStore();
      const record = store.recordEffect.bind(store);
      if (phase === 'read')
        store.effect = async () => {
          throw invalidated();
        };
      else
        store.recordEffect = async (...args) => {
          if (args[2].status === phase) throw invalidated();
          await record(...args);
        };
      const f = await fixture(store, [
        async function* (request) {
          yield {
            type: 'output',
            output: await request.capabilities.call('write@1', 'private reply'),
          };
        },
      ]);
      await store.acceptSubmission(f.instance.sessionId, {
        interactionId: pending.interactionId,
        action: 'submit',
        payload: false,
      });
      await f.instance.restore();
      await vi.waitFor(() => expect(f.instance.getSnapshot().run?.status).toBe('failed'));
      expect(f.instance.getSnapshot().run?.error).toMatchObject({
        code: 'stale',
        message: 'The request targets stale state.',
      });
      expect(JSON.stringify(f.instance.getSnapshot())).not.toContain('private-storage-canary');
      expect(JSON.stringify(f.instance.getSnapshot())).not.toContain('private reply');
    },
  );
  test('ignores inherited and accessor invalidation markers', async () => {
    for (const error of [
      Object.create({ invalidated: true }),
      Object.defineProperty({}, 'invalidated', {
        get() {
          throw new Error('Do not read accessors.');
        },
      }),
    ]) {
      const f = await fixture();
      f.executor.agent.pending = async () => {
        throw error;
      };
      await expect(f.instance.restore()).rejects.toMatchObject({ code: 'executor_error' });
    }
  });
});
