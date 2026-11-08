// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import {
  type BudgetLimits,
  type CapabilityBinding,
  type CapabilityContext,
  type CapabilityRequests,
  createRuntime,
  type DiagnosticEvent,
  galaxieField,
  httpCapability,
  type InteractionId,
  isGalaxieError,
  type PendingInteraction,
  type ReconcileResult,
  type RunRequest,
  type Schema,
  type SessionId,
  toErrorInfo,
  type ViewRevision,
} from '../src/index.js';
import {
  binding,
  brokerFixture,
  collect,
  deferred,
  definition,
  FakeExecutor,
  flush,
} from './fake-executor.js';
import { MemoryRecoveryStore } from './support/memory-recovery-store.js';

const runtimes: Array<{ dispose(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  vi.useRealTimers();
});

async function createFixture(
  bound: CapabilityBinding,
): Promise<Awaited<ReturnType<typeof brokerFixture>>> {
  const fixture = await brokerFixture({
    requests: { 'write@1': { input: z.string(), output: z.string(), kind: 'write' } },
    bindings: { 'write@1': bound },
  });
  runtimes.push(fixture.runtime);
  return fixture;
}

const reconcile = async (): Promise<ReconcileResult<string>> => ({ outcome: 'unknown' });

describe('reconcile binding validation', () => {
  test('creates a binding with reconciliation and no automatic retry', async () => {
    await expect(
      createFixture(binding({ kind: 'write', retry: 'none', reconcile })),
    ).resolves.toBeDefined();
  });

  test.each(['idempotent', 'idempotency-key'] as const)(
    'rejects reconciliation with retry %s at creation',
    async (retry) => {
      await expect(
        createFixture(binding({ kind: 'write', retry, reconcile })),
      ).rejects.toMatchObject({ code: 'invalid' });
    },
  );

  test('rejects a non-function reconciliation hook at creation', async () => {
    await expect(
      createFixture(
        binding({
          kind: 'write',
          retry: 'none',
          // @ts-expect-error -- runtime validates hooks supplied by untyped hosts.
          reconcile: 'not a function',
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  test('forwards the supplied reconciliation hook through an HTTP binding', () => {
    const bound = httpCapability<unknown, string>({
      ...binding({ kind: 'write' }),
      destination: 'host-server',
      url: 'https://api.example.test/write',
      method: 'POST',
      retry: 'none',
      reconcile,
    });
    expect(bound.reconcile).toBe(reconcile);
  });

  test('creates a binding without a reconciliation hook', async () => {
    await expect(createFixture(binding({ kind: 'write' }))).resolves.toBeDefined();
  });
});

const sessionId = 'f03855d0-093d-44ef-afdd-58bff38d34dc' as SessionId;
const interaction: PendingInteraction = {
  interactionId: 'reconcile-answer' as InteractionId,
  surfaceId: 'main',
  viewRevision: 'r1' as ViewRevision,
  component: 'tests.Question/v1',
  props: {},
};

async function resumeWrite(
  store: MemoryRecoveryStore,
  bound: CapabilityBinding,
  options: {
    output?: Schema;
    budgets?: Partial<BudgetLimits>;
    requests?: CapabilityRequests;
    bindings?: Readonly<Record<string, CapabilityBinding>>;
    execute?: (request: RunRequest) => Promise<unknown>;
  } = {},
) {
  const execute =
    options.execute ?? ((request: RunRequest) => request.capabilities.call('write@1', 'first'));
  const result = deferred<PromiseSettledResult<unknown>>();
  const executor = new FakeExecutor([
    async function* (request) {
      try {
        const output = await execute(request);
        result.resolve({ status: 'fulfilled', value: output });
        yield { type: 'output', output };
      } catch (error) {
        result.resolve({ status: 'rejected', reason: error });
        yield {
          type: 'error',
          error: toErrorInfo(isGalaxieError(error) ? error.code : 'executor_error'),
        };
      }
    },
  ]);
  Object.assign(executor.features, { resume: true, checkpoints: true });
  executor.agent.pending = async () => interaction;
  const diagnostics: DiagnosticEvent[] = [];
  const runtime = createRuntime({
    appId: 'reconcile-tests',
    executors: [executor],
    diagnostics: (event) => diagnostics.push(event),
    ...(options.budgets === undefined ? {} : { budgets: options.budgets }),
  });
  runtimes.push(runtime);
  const instance = await runtime.create(
    {
      ...definition,
      capabilities: {
        optional: {
          'write@1': { input: z.string(), output: options.output ?? z.string(), kind: 'write' },
          ...options.requests,
        },
      },
    },
    {
      principalScope: 'user',
      sessionId,
      agent: {},
      recovery: store,
      bindings: { 'write@1': bound, ...options.bindings },
      ...(bound.approval === 'confirm'
        ? { confirmations: { capabilities: ['write@1'], policyRevision: () => 'v1' } }
        : {}),
    },
  );
  await store.recordSession(sessionId, {
    agentId: definition.id,
    agentVersion: definition.version,
    executorId: 'fake',
  });
  await instance.prepare();
  const restored = await instance.restore();
  if (restored === undefined) throw new Error('Expected a restored run.');
  return {
    runtime,
    instance,
    diagnostics,
    runId: restored.runId,
    result: result.promise,
    events: collect(instance.events(restored.runId)),
  };
}

async function seededWrite(
  status: 'dispatched' | 'outcome_unknown' | 'succeeded' = 'outcome_unknown',
) {
  const store = new MemoryRecoveryStore();
  await store.acceptSubmission(sessionId, {
    interactionId: interaction.interactionId,
    action: 'submit',
    payload: false,
  });
  const entered = deferred<CapabilityContext>();
  const first = await resumeWrite(
    store,
    binding({
      kind: 'write',
      invoke: async (_input, context) => {
        entered.resolve(context);
        if (status === 'succeeded') return 'stored receipt';
        return new Promise((_resolve, reject) =>
          context.signal.addEventListener('abort', () => reject(new Error('Interrupted write'))),
        );
      },
    }),
    {
      execute: async (request) => {
        const output = await request.capabilities.call('write@1', 'first');
        await new Promise<void>((resolve) =>
          request.signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        return output;
      },
    },
  );
  const { effectId } = await entered.promise;
  await vi.waitFor(() =>
    expect([...store.journal.values()][0]?.status).toBe(
      status === 'succeeded' ? 'succeeded' : 'dispatched',
    ),
  );
  await first.runtime.dispose();
  if (status === 'dispatched') {
    const record = await store.effect(sessionId, effectId);
    if (record === undefined) throw new Error('Missing write receipt.');
    await store.recordEffect(sessionId, effectId, { ...record, status });
  }
  return { store, effectId };
}

describe('applied write reconciliation', () => {
  test.each(['dispatched', 'outcome_unknown'] as const)(
    'settles a %s receipt without invoking or opening a confirmation',
    async (status) => {
      const { store, effectId } = await seededWrite(status);
      const hook = vi.fn(async (): Promise<ReconcileResult> => ({
        outcome: 'applied',
        output: 'reconciled receipt',
      }));
      const invoke = vi.fn(async () => 'unused');
      const fixture = await resumeWrite(
        store,
        binding({ kind: 'write', approval: 'confirm', reconcile: hook, invoke }),
      );
      expect(await fixture.result).toEqual({ status: 'fulfilled', value: 'reconciled receipt' });
      await fixture.events;
      expect(await store.effect(sessionId, effectId)).toMatchObject({
        status: 'succeeded',
        output: 'reconciled receipt',
      });
      expect(invoke).not.toHaveBeenCalled();
      expect(fixture.instance.getSnapshot().confirmations).toBeUndefined();
      expect(fixture.diagnostics.some((event) => event.kind === 'confirmation_requested')).toBe(
        false,
      );
      expect(hook).toHaveBeenCalledExactlyOnceWith(
        effectId,
        expect.objectContaining({
          effectId,
          signal: expect.any(AbortSignal),
          runId: fixture.runId,
          principalScope: 'user',
          agent: { id: definition.id, version: definition.version, hash: '' },
        }),
      );
      expect(
        fixture.diagnostics.filter((event) => event.kind === 'effect_reconciled_applied'),
      ).toEqual([
        {
          instanceId: fixture.instance.instanceId,
          kind: 'effect_reconciled_applied',
          runId: fixture.runId,
          effectId,
        },
      ]);
    },
  );

  test('rejects an applied output that does not match the output schema', async () => {
    const { store, effectId } = await seededWrite();
    const fixture = await resumeWrite(
      store,
      binding({ kind: 'write', reconcile: async () => ({ outcome: 'applied', output: 42 }) }),
    );
    expect(await fixture.result).toMatchObject({ status: 'rejected', reason: { code: 'invalid' } });
    await fixture.events;
    expect((await store.effect(sessionId, effectId))?.status).toBe('outcome_unknown');
  });

  test('registers private applied outputs before a later structured call', async () => {
    const { store } = await seededWrite();
    const send = vi.fn(async () => 'unused');
    const fixture = await resumeWrite(
      store,
      binding({
        kind: 'write',
        reconcile: async () => ({ outcome: 'applied', output: 'Private-Canary-Handle' }),
      }),
      {
        output: z.string().meta(galaxieField({ label: 'private-user' })),
        requests: {
          'send@1': {
            input: z
              .string()
              .regex(/^[a-z-]+$/)
              .max(64),
            output: z.string(),
            kind: 'read',
          },
        },
        bindings: { 'send@1': binding({ destination: 'host-server', invoke: send }) },
        execute: async ({ capabilities }) => {
          await capabilities.call('write@1', 'first');
          return capabilities.call('send@1', 'private-canary-handle');
        },
      },
    );
    expect(await fixture.result).toMatchObject({ status: 'rejected', reason: { code: 'denied' } });
    await fixture.events;
    expect(send).not.toHaveBeenCalled();
    expect(fixture.instance.getSnapshot().run?.labels).toContain('private-user');
  });

  test('bounds an applied output with the run payload budget', async () => {
    const { store, effectId } = await seededWrite();
    const fixture = await resumeWrite(
      store,
      binding({
        kind: 'write',
        reconcile: async () => ({ outcome: 'applied', output: 'ééééé' }),
      }),
      { budgets: { payloadBytes: 8 } },
    );
    expect(await fixture.result).toMatchObject({
      status: 'rejected',
      reason: { code: 'budget_exceeded' },
    });
    await fixture.events;
    expect(fixture.instance.getSnapshot().run?.error?.code).toBe('budget_exceeded');
    expect((await store.effect(sessionId, effectId))?.status).toBe('outcome_unknown');
  });
});

describe('write replay after reconciliation', () => {
  test.each(['none', 'confirm'] as const)(
    'replays under the same effect ID with approval %s',
    async (approval) => {
      const { store, effectId } = await seededWrite();
      const hook = vi.fn(async (): Promise<ReconcileResult> => ({ outcome: 'not-applied' }));
      const invoke = vi.fn(async () => 'retried receipt');
      const fixture = await resumeWrite(
        store,
        binding({ kind: 'write', approval, reconcile: hook, invoke }),
      );
      if (approval === 'confirm') {
        await vi.waitFor(() =>
          expect(fixture.instance.getSnapshot().confirmations).toHaveLength(1),
        );
        expect(hook).toHaveBeenCalledTimes(1);
        expect(invoke).not.toHaveBeenCalled();
        const pending = fixture.instance.getSnapshot().confirmations?.[0];
        if (pending === undefined) throw new Error('Missing confirmation.');
        expect(fixture.instance.respond(pending.id, 'approve')).toEqual({ status: 'approved' });
      }
      expect(await fixture.result).toEqual({ status: 'fulfilled', value: 'retried receipt' });
      await fixture.events;
      expect(hook).toHaveBeenCalledExactlyOnceWith(effectId, expect.any(Object));
      expect(invoke).toHaveBeenCalledExactlyOnceWith(
        'first',
        expect.objectContaining({ effectId }),
      );
      expect(await store.effect(sessionId, effectId)).toMatchObject({
        status: 'succeeded',
        output: 'retried receipt',
      });
      expect(
        fixture.diagnostics.filter((event) => event.kind === 'effect_reconciled_not_applied'),
      ).toEqual([
        {
          instanceId: fixture.instance.instanceId,
          kind: 'effect_reconciled_not_applied',
          runId: fixture.runId,
          effectId,
        },
      ]);
    },
  );

  test('gives the replay a full deadline after a not-applied answer', async () => {
    const { store } = await seededWrite();
    vi.useFakeTimers();
    const answer = deferred<ReconcileResult>();
    const output = deferred<string>();
    const hook = vi.fn(() => answer.promise);
    const invoke = vi.fn(() => output.promise);
    const fixture = await resumeWrite(
      store,
      binding({ kind: 'write', timeoutMs: 1000, reconcile: hook, invoke }),
    );
    await vi.waitFor(() => expect(hook).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(600);
    answer.resolve({ outcome: 'not-applied' });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(600);
    output.resolve('retried receipt');
    expect(await fixture.result).toEqual({ status: 'fulfilled', value: 'retried receipt' });
    await fixture.events;
  });

  test('clears the consult timer while waiting for fresh approval', async () => {
    const { store } = await seededWrite();
    vi.useFakeTimers();
    const hook = vi.fn(async (): Promise<ReconcileResult> => ({ outcome: 'not-applied' }));
    const invoke = vi.fn(async () => 'retried receipt');
    const fixture = await resumeWrite(
      store,
      binding({ kind: 'write', approval: 'confirm', timeoutMs: 1000, reconcile: hook, invoke }),
    );
    await vi.waitFor(() => expect(fixture.instance.getSnapshot().confirmations).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(2000);
    expect(fixture.instance.getSnapshot().confirmations).toHaveLength(1);
    expect(invoke).not.toHaveBeenCalled();
    const pending = fixture.instance.getSnapshot().confirmations?.[0];
    if (pending === undefined) throw new Error('Missing confirmation.');
    expect(fixture.instance.respond(pending.id, 'approve')).toEqual({ status: 'approved' });
    expect(await fixture.result).toEqual({ status: 'fulfilled', value: 'retried receipt' });
    await fixture.events;
  });
});

describe('unresolved write reconciliation', () => {
  const hostError = new Error('Host-only reconciliation failure');
  const answers: ReadonlyArray<{
    name: string;
    hook: NonNullable<CapabilityBinding['reconcile']>;
    error?: Error;
  }> = [
    { name: 'unknown', hook: async () => ({ outcome: 'unknown' }) },
    {
      name: 'a synchronous throw',
      hook: () => {
        throw hostError;
      },
      error: hostError,
    },
    { name: 'a rejection', hook: () => Promise.reject(hostError), error: hostError },
    ...[
      { name: 'an unrecognized outcome', answer: { outcome: 'maybe' } },
      { name: 'an applied answer without output', answer: { outcome: 'applied' } },
      { name: 'a non-object answer', answer: null },
    ].map(({ name, answer }) => ({
      name,
      hook: async () => answer as unknown as ReconcileResult,
    })),
  ];

  test.each(answers)('fails closed for $name', async ({ hook: implementation, error }) => {
    const { store, effectId } = await seededWrite();
    const hook = vi.fn(implementation);
    const invoke = vi.fn(async () => 'unused');
    const fixture = await resumeWrite(store, binding({ kind: 'write', reconcile: hook, invoke }));
    expect(await fixture.result).toMatchObject({
      status: 'rejected',
      reason: { code: 'outcome_unknown' },
    });
    await fixture.events;
    expect(hook).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
    expect((await store.effect(sessionId, effectId))?.status).toBe('outcome_unknown');
    expect(fixture.diagnostics.filter((event) => event.kind === 'effect_outcome_unknown')).toEqual([
      {
        instanceId: fixture.instance.instanceId,
        kind: 'effect_outcome_unknown',
        runId: fixture.runId,
        effectId,
      },
    ]);
    const failures = fixture.diagnostics.filter((event) => event.kind === 'capability_failed');
    if (error === undefined) expect(failures).toEqual([]);
    else {
      expect(failures).toHaveLength(1);
      expect(failures[0]?.error).toBe(error);
    }
  });

  test.each(['none', 'confirm'] as const)(
    'times out a hanging consult with approval %s and aborts its signal',
    async (approval) => {
      const { store, effectId } = await seededWrite();
      vi.useFakeTimers();
      const hook = vi.fn(
        (_effectId: string, _context: CapabilityContext) => new Promise<ReconcileResult>(() => {}),
      );
      const invoke = vi.fn(async () => 'unused');
      const fixture = await resumeWrite(
        store,
        binding({ kind: 'write', approval, timeoutMs: 1000, reconcile: hook, invoke }),
      );
      await vi.waitFor(() => expect(hook).toHaveBeenCalledTimes(1));
      const context = hook.mock.calls[0]?.[1];
      expect(context?.signal.aborted).toBe(false);
      expect(fixture.instance.getSnapshot().confirmations).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1000);
      expect(await fixture.result).toMatchObject({
        status: 'rejected',
        reason: { code: 'timeout' },
      });
      await fixture.events;
      expect(context?.signal.aborted).toBe(true);
      expect(invoke).not.toHaveBeenCalled();
      expect((await store.effect(sessionId, effectId))?.status).toBe('outcome_unknown');
      expect(fixture.diagnostics.some((event) => event.kind === 'capability_failed')).toBe(false);
    },
  );

  test.each(['cancel', 'dispose'] as const)(
    'aborts the consult signal on run %s and preserves the unknown receipt',
    async (action) => {
      const { store, effectId } = await seededWrite();
      const answer = deferred<ReconcileResult>();
      const hook = vi.fn((_effectId: string, _context: CapabilityContext) => answer.promise);
      const invoke = vi.fn(async () => 'unused');
      const fixture = await resumeWrite(store, binding({ kind: 'write', reconcile: hook, invoke }));
      await vi.waitFor(() => expect(hook).toHaveBeenCalledTimes(1));
      const context = hook.mock.calls[0]?.[1];
      if (action === 'cancel') await fixture.instance.cancel(fixture.runId);
      else await fixture.runtime.dispose();
      expect(await fixture.result).toMatchObject({
        status: 'rejected',
        reason: { code: 'cancelled' },
      });
      expect(context?.signal.aborted).toBe(true);
      answer.resolve({ outcome: 'applied', output: 'late receipt' });
      await flush();
      await fixture.events;
      expect(invoke).not.toHaveBeenCalled();
      expect((await store.effect(sessionId, effectId))?.status).toBe('outcome_unknown');
      expect(
        fixture.diagnostics.some((event) =>
          ['capability_failed', 'effect_reconciled_applied'].includes(event.kind),
        ),
      ).toBe(false);
    },
  );

  test('consults once on each of two restores of the same unresolved write', async () => {
    const { store, effectId } = await seededWrite();
    const hook = vi.fn(async (): Promise<ReconcileResult> => ({ outcome: 'unknown' }));
    const invoke = vi.fn(async () => 'unused');
    for (let count = 1; count <= 2; count++) {
      const fixture = await resumeWrite(store, binding({ kind: 'write', reconcile: hook, invoke }));
      expect(await fixture.result).toMatchObject({
        status: 'rejected',
        reason: { code: 'outcome_unknown' },
      });
      await fixture.events;
      expect(hook).toHaveBeenCalledTimes(count);
      expect(hook).toHaveBeenLastCalledWith(effectId, expect.any(Object));
      await fixture.runtime.dispose();
    }
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('reconciliation bypass guards', () => {
  test('replays a succeeded receipt without consulting the hook', async () => {
    const { store, effectId } = await seededWrite('succeeded');
    const hook = vi.fn(reconcile);
    const invoke = vi.fn(async () => 'unused');
    const fixture = await resumeWrite(store, binding({ kind: 'write', reconcile: hook, invoke }));
    expect(await fixture.result).toEqual({ status: 'fulfilled', value: 'stored receipt' });
    await fixture.events;
    expect(hook).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect((await store.effect(sessionId, effectId))?.status).toBe('succeeded');
  });

  test('invokes a first write with an absent receipt without consulting the hook', async () => {
    const store = new MemoryRecoveryStore();
    await store.acceptSubmission(sessionId, {
      interactionId: interaction.interactionId,
      action: 'submit',
      payload: false,
    });
    const hook = vi.fn(reconcile);
    const invoke = vi.fn(async () => 'first receipt');
    const fixture = await resumeWrite(store, binding({ kind: 'write', reconcile: hook, invoke }));
    expect(await fixture.result).toEqual({ status: 'fulfilled', value: 'first receipt' });
    await fixture.events;
    expect(hook).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test('invokes without a recovery store without consulting the hook', async () => {
    const hook = vi.fn(reconcile);
    const invoke = vi.fn(async () => 'first receipt');
    const fixture = await createFixture(binding({ kind: 'write', reconcile: hook, invoke }));
    fixture.executor.scripts.push(async function* ({ capabilities }) {
      yield { type: 'output', output: await capabilities.call('write@1', 'first') };
    });
    const { runId } = await fixture.instance.start('input');
    expect((await collect(fixture.instance.events(runId))).at(-1)).toMatchObject({
      type: 'output',
      output: 'first receipt',
    });
    expect(fixture.scriptErrors).toEqual([]);
    expect(hook).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test('keeps the journal writes and diagnostics unchanged without a bound hook', async () => {
    const { store, effectId } = await seededWrite();
    const writes = vi.spyOn(store, 'recordEffect');
    const invoke = vi.fn(async () => 'unused');
    const fixture = await resumeWrite(store, binding({ kind: 'write', invoke }));
    expect(await fixture.result).toMatchObject({
      status: 'rejected',
      reason: { code: 'outcome_unknown' },
    });
    await fixture.events;
    expect(invoke).not.toHaveBeenCalled();
    expect(writes.mock.calls.map(([, , record]) => record.status)).toEqual(['outcome_unknown']);
    expect(fixture.diagnostics).toEqual([
      {
        instanceId: fixture.instance.instanceId,
        kind: 'effect_outcome_unknown',
        runId: fixture.runId,
        effectId,
      },
    ]);
  });
});
