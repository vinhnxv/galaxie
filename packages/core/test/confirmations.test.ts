// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, expect, onTestFinished, test, vi } from 'vitest';
import { z } from 'zod';
import { approvedCopy, ConfirmationGate } from '../src/confirmations.js';
import {
  type AgentInstance,
  type CapabilityBinding,
  type CapabilityRequests,
  type ConfirmationOptions,
  type CreateOptions,
  createRuntime,
  type DiagnosticEvent,
  type PendingConfirmation,
  type RunRequest,
  type RuntimeOptions,
} from '../src/index.js';
import { binding, collect, deferred, definition, FakeExecutor, flush } from './fake-executor.js';
import { assertSpanTree, createSpanRecorder, serializeSpans } from './span-tree.js';
import { MemoryRecoveryStore } from './support/memory-recovery-store.js';

afterEach(() => vi.useRealTimers());

async function fixture(
  script: (request: RunRequest) => AsyncIterable<import('../src/index.js').ExecutorEvent>,
  options: Partial<ConfirmationOptions> = {},
  overrides: Partial<CapabilityBinding> = {},
  extra: { create?: Partial<CreateOptions>; runtime?: Partial<RuntimeOptions> } = {},
) {
  const scriptErrors: unknown[] = [];
  const diagnostics: DiagnosticEvent[] = [];
  const invoke = vi.fn<CapabilityBinding['invoke']>(async () => 'ok');
  const runtime = createRuntime({
    appId: 'confirmations',
    executors: [
      new FakeExecutor([
        async function* (request) {
          try {
            yield* script(request);
          } catch (error) {
            scriptErrors.push(error);
            throw error;
          }
        },
      ]),
    ],
    ...extra.runtime,
    diagnostics: (event) => diagnostics.push(event),
  });
  const requests: CapabilityRequests = {
    'write@1': { input: z.unknown(), output: z.string(), kind: 'write' },
  };
  const instance = await runtime.create(
    {
      ...definition,
      capabilities: {
        required: requests,
      },
    },
    {
      ...extra.create,
      principalScope: 'user',
      agent: {},
      bindings: {
        'write@1': binding({ kind: 'write', approval: 'confirm', invoke, ...overrides }),
      },
      confirmations:
        options === null
          ? options
          : { capabilities: ['write@1'], policyRevision: () => 'v1', ...options },
    },
  );
  onTestFinished(async () => {
    await runtime.dispose();
    expect(scriptErrors).toEqual([]);
  });
  await instance.prepare();
  const { runId } = await instance.start('input');
  const events = collect(instance.events(runId));
  return { runtime, instance, invoke, diagnostics, runId, events };
}

test('approval dispatches the frozen approved copy once with an effect ID', async () => {
  const args = { nested: { value: 'original' } };
  const f = await fixture(async function* ({ capabilities }) {
    await expect(capabilities.call('write@1', args)).resolves.toBe('ok');
    yield { type: 'output', output: null };
  });
  await vi.waitFor(() => expect(f.instance.getSnapshot().confirmations).toHaveLength(1));
  const pending = f.instance.getSnapshot().confirmations?.[0];
  if (pending === undefined) throw new Error('Missing confirmation.');
  expect(Object.isFrozen(pending.arguments)).toBe(true);
  expect(Object.isFrozen((pending.arguments as typeof args).nested)).toBe(true);
  args.nested.value = 'changed';
  expect(f.instance.respond(pending.id, 'approve')).toEqual({ status: 'approved' });
  expect(f.instance.respond(pending.id, 'approve')).toEqual({ status: 'stale' });
  await f.events;
  expect(f.invoke).toHaveBeenCalledExactlyOnceWith(
    { nested: { value: 'original' } },
    expect.objectContaining({ effectId: expect.any(String), principalScope: 'user' }),
  );
  expect(f.instance.getSnapshot().confirmations).toBeUndefined();
  await f.runtime.dispose();
});

test('decline fails denied without invoking', async () => {
  const f = await fixture(async function* ({ capabilities }) {
    await expect(capabilities.call('write@1', { secret: 'argument' })).rejects.toMatchObject({
      code: 'denied',
    });
    yield { type: 'output', output: null };
  });
  await vi.waitFor(() => expect(f.instance.getSnapshot().confirmations).toHaveLength(1));
  const id = pending(f.instance).id;
  expect(f.instance.respond(id, 'decline')).toEqual({ status: 'declined' });
  await f.events;
  expect(f.invoke).not.toHaveBeenCalled();
  expect(f.diagnostics.map((event) => event.kind)).toEqual([
    'confirmation_requested',
    'confirmation_declined',
  ]);
  await f.runtime.dispose();
});

function pending(instance: AgentInstance<unknown, unknown>): PendingConfirmation {
  const entry = instance.getSnapshot().confirmations?.[0];
  if (entry === undefined) throw new Error('Missing confirmation.');
  return entry;
}

async function opened(instance: AgentInstance<unknown, unknown>, count = 1): Promise<void> {
  await vi.waitFor(() => expect(instance.getSnapshot().confirmations).toHaveLength(count));
}

function denied(code = 'denied') {
  return async function* ({ capabilities }: RunRequest) {
    await expect(
      capabilities.call('write@1', { value: 'private-argument-marker' }),
    ).rejects.toMatchObject({ code });
    yield { type: 'output' as const, output: null };
  };
}

test('expiry clears the entry, timer and signal listeners', async () => {
  vi.useFakeTimers();
  const signal = new AbortController().signal;
  const added = vi.spyOn(signal, 'addEventListener');
  const removed = vi.spyOn(signal, 'removeEventListener');
  const f = await fixture(denied(), { expiresInMs: 1000, signals: [signal] });
  await opened(f.instance);
  const id = pending(f.instance).id;
  await vi.advanceTimersByTimeAsync(1000);
  await f.events;
  expect(f.instance.respond(id, 'approve')).toEqual({ status: 'stale' });
  expect(f.instance.getSnapshot().confirmations).toBeUndefined();
  expect(f.invoke).not.toHaveBeenCalled();
  expect(f.diagnostics.filter((event) => event.kind === 'confirmation_expired')).toHaveLength(1);
  expect(removed.mock.calls).toEqual(added.mock.calls.map(([type, listener]) => [type, listener]));
  expect(vi.getTimerCount()).toBe(0);
});

test.each([0, 1])('each host signal invalidates independently: %i', async (index) => {
  const signals = [new AbortController(), new AbortController()];
  const f = await fixture(denied(), { signals: signals.map((controller) => controller.signal) });
  await opened(f.instance);
  const id = pending(f.instance).id;
  signals[index]?.abort('host-error-marker');
  await f.events;
  expect(f.invoke).not.toHaveBeenCalled();
  expect(f.instance.respond(id, 'approve')).toEqual({ status: 'stale' });
  expect(f.diagnostics.map((event) => event.kind)).toEqual([
    'confirmation_requested',
    'confirmation_invalidated',
  ]);
});

test('an already-aborted host signal never publishes an entry', async () => {
  const f = await fixture(denied(), { signals: [AbortSignal.abort('host-error-marker')] });
  const snapshots: unknown[] = [];
  f.instance.subscribe(() => snapshots.push(f.instance.getSnapshot().confirmations));
  await f.events;
  expect(snapshots.every((entry) => entry === undefined)).toBe(true);
  expect(f.invoke).not.toHaveBeenCalled();
  expect(f.diagnostics.map((event) => event.kind)).toEqual(['confirmation_invalidated']);
});

test('disposal invalidates pending approval without invocation', async () => {
  const f = await fixture(denied('cancelled'));
  await opened(f.instance);
  await f.instance.dispose();
  expect(f.instance.getSnapshot().confirmations).toBeUndefined();
  expect(f.invoke).not.toHaveBeenCalled();
  expect(f.diagnostics.filter((event) => event.kind === 'confirmation_invalidated')).toHaveLength(
    1,
  );
});

test('policy change at approval invalidates rather than dispatching', async () => {
  let revision = 'v1';
  const f = await fixture(denied(), { policyRevision: () => revision });
  await opened(f.instance);
  const id = pending(f.instance).id;
  revision = 'v2';
  expect(f.instance.respond(id, 'approve')).toEqual({ status: 'stale' });
  await f.events;
  expect(f.invoke).not.toHaveBeenCalled();
  expect(f.diagnostics.at(-1)?.kind).toBe('confirmation_invalidated');
});

test('policy is checked again after approval at dispatch', async () => {
  let revision = 'v1';
  const f = await fixture(denied(), { policyRevision: () => revision });
  await opened(f.instance);
  expect(f.instance.respond(pending(f.instance).id, 'approve')).toEqual({ status: 'approved' });
  revision = 'v2';
  await f.events;
  expect(f.invoke).not.toHaveBeenCalled();
  expect(f.diagnostics.at(-1)?.kind).toBe('confirmation_invalidated');
});

test('a policy change queued during the dispatch check still prevents the call', async () => {
  let revision = 'v1';
  let armed = false;
  const f = await fixture(denied(), {
    policyRevision: () => {
      const current = revision;
      if (armed) {
        // The first read after approval is the dispatch check; change the policy right after it.
        armed = false;
        queueMicrotask(() => {
          revision = 'v2';
        });
      }
      return current;
    },
  });
  await opened(f.instance);
  expect(f.instance.respond(pending(f.instance).id, 'approve')).toEqual({ status: 'approved' });
  armed = true;
  await f.events;
  expect(f.invoke).not.toHaveBeenCalled();
  expect(f.diagnostics.at(-1)?.kind).toBe('confirmation_invalidated');
});

test('frozen approved arguments reject mutation after approval', async () => {
  const f = await fixture(async function* ({ capabilities }) {
    await capabilities.call('write@1', { nested: { value: 'original' } });
    yield { type: 'output', output: null };
  });
  await opened(f.instance);
  const entry = pending(f.instance);
  f.instance.respond(entry.id, 'approve');
  expect(() => {
    (entry.arguments as { nested: { value: string } }).nested.value = 'changed';
  }).toThrow(TypeError);
  await f.events;
  expect(f.invoke.mock.calls[0]?.[0]).toEqual({ nested: { value: 'original' } });
});

test('identical later calls require a fresh approval', async () => {
  const f = await fixture(async function* ({ capabilities }) {
    await capabilities.call('write@1', { value: 1 });
    await capabilities.call('write@1', { value: 1 });
    yield { type: 'output', output: null };
  });
  await opened(f.instance);
  const first = pending(f.instance).id;
  f.instance.respond(first, 'approve');
  await vi.waitFor(() => expect(pending(f.instance).id).not.toBe(first));
  expect(f.invoke).toHaveBeenCalledTimes(1);
  expect(f.instance.respond(first, 'approve')).toEqual({ status: 'stale' });
  f.instance.respond(pending(f.instance).id, 'approve');
  await f.events;
  expect(f.invoke).toHaveBeenCalledTimes(2);
  expect(f.invoke.mock.calls[0]?.[1].effectId).not.toBe(f.invoke.mock.calls[1]?.[1].effectId);
});

test('parallel confirmations wait independently without holding concurrency slots', async () => {
  const f = await fixture(async function* ({ capabilities }) {
    await Promise.all([
      capabilities.call('write@1', { value: 1 }),
      capabilities.call('write@1', { value: 2 }),
    ]);
    yield { type: 'output', output: null };
  });
  await opened(f.instance, 2);
  const entries = f.instance.getSnapshot().confirmations ?? [];
  f.instance.respond(entries[1]?.id as never, 'approve');
  await vi.waitFor(() => expect(f.invoke).toHaveBeenCalledTimes(1));
  expect(f.invoke.mock.calls[0]?.[0]).toEqual({ value: 2 });
  f.instance.respond(entries[0]?.id as never, 'approve');
  await f.events;
  expect(f.invoke).toHaveBeenCalledTimes(2);
});

test('binding timeout begins after approval', async () => {
  vi.useFakeTimers();
  const waiting = deferred<unknown>();
  const f = await fixture(
    denied('timeout'),
    { expiresInMs: 5000 },
    { timeoutMs: 100, invoke: () => waiting.promise },
  );
  await opened(f.instance);
  await vi.advanceTimersByTimeAsync(500);
  expect(f.instance.getSnapshot().confirmations).toHaveLength(1);
  f.instance.respond(pending(f.instance).id, 'approve');
  await vi.advanceTimersByTimeAsync(100);
  await f.events;
  waiting.resolve('late');
  await flush();
  expect(f.instance.getSnapshot().confirmations).toBeUndefined();
});

test.each(['cancel', 'budget'] as const)('waiting is bounded by run %s', async (cause) => {
  vi.useFakeTimers();
  const f = await fixture(
    denied('cancelled'),
    {},
    {},
    { runtime: { budgets: { wallClockMs: 500 } } },
  );
  await opened(f.instance);
  const id = pending(f.instance).id;
  if (cause === 'cancel') await f.instance.cancel(f.runId);
  else await vi.advanceTimersByTimeAsync(500);
  await f.events;
  expect(f.instance.getSnapshot().run?.status).toBe(cause === 'cancel' ? 'cancelled' : 'failed');
  if (cause === 'budget') expect(f.instance.getSnapshot().run?.error?.code).toBe('budget_exceeded');
  expect(f.instance.respond(id, 'approve')).toEqual({ status: 'stale' });
  expect(f.invoke).not.toHaveBeenCalled();
  expect(f.diagnostics.filter((event) => event.kind.startsWith('confirmation_'))).toHaveLength(1);
});

test.each([
  null,
  { capabilities: [] },
  { expiresInMs: 999 },
  { expiresInMs: 600001 },
  { expiresInMs: 1000.5 },
  { signals: [{}] },
  { policyRevision: 'bad' },
])('create rejects invalid or uncovered options: %j', async (options) => {
  await expect(fixture(denied(), options as never)).rejects.toMatchObject({ code: 'invalid' });
});

test.each(['', 'x'.repeat(129), 3, null, new Error('host-error-marker')])(
  'bad policy revisions fail unavailable without host text: %j',
  async (revision) => {
    const f = await fixture(denied('unavailable'), {
      policyRevision: (() => {
        if (revision instanceof Error) throw revision;
        return revision;
      }) as never,
    });
    await f.events;
    expect(f.invoke).not.toHaveBeenCalled();
    expect(JSON.stringify(f.diagnostics)).not.toContain('host-error-marker');
  },
);

test.each([new Date(), undefined, { value: undefined }, Number.NaN])(
  'non-JSON arguments fail invalid: %j',
  async (value) => {
    const f = await fixture(async function* ({ capabilities }) {
      await expect(capabilities.call('write@1', value)).rejects.toMatchObject({ code: 'invalid' });
      yield { type: 'output', output: null };
    });
    await f.events;
    expect(f.invoke).not.toHaveBeenCalled();
    expect(f.instance.getSnapshot().confirmations).toBeUndefined();
  },
);

test.each(['succeeded', 'dispatched', 'outcome_unknown'] as const)(
  'recovery %s does not ask for approval',
  async (status) => {
    const store = new MemoryRecoveryStore();
    store.effect = async () => {
      const inputDigest = await import('../src/confirmations.js').then(({ digest }) =>
        digest({ value: 1 }),
      );
      return status === 'succeeded'
        ? { status, inputDigest, output: 'recorded' }
        : { status, inputDigest };
    };
    const f = await fixture(
      async function* ({ capabilities }) {
        const call = capabilities.call('write@1', { value: 1 });
        if (status === 'succeeded') await expect(call).resolves.toBe('recorded');
        else await expect(call).rejects.toMatchObject({ code: 'outcome_unknown' });
        yield { type: 'output', output: null };
      },
      {},
      {},
      { create: { recovery: store } },
    );
    await f.events;
    expect(f.instance.getSnapshot().run?.status).toBe('succeeded');
    expect(f.invoke).not.toHaveBeenCalled();
    expect(f.diagnostics.some((event) => event.kind.startsWith('confirmation_'))).toBe(false);
  },
);

test.each(['dispatched', 'outcome_unknown'] as const)(
  'a retryable %s write asks for fresh approval and keeps its journal effect ID',
  async (status) => {
    const store = new MemoryRecoveryStore();
    let recorded: string | undefined;
    const effect = store.effect.bind(store);
    store.effect = async (_sessionId, effectId) => {
      recorded = effectId;
      const { digest } = await import('../src/confirmations.js');
      return { status, inputDigest: await digest({ value: 1 }) };
    };
    const f = await fixture(
      async function* ({ capabilities }) {
        await capabilities.call('write@1', { value: 1 });
        yield { type: 'output', output: null };
      },
      {},
      { retry: 'idempotency-key' },
      { create: { recovery: store } },
    );
    await opened(f.instance);
    expect(f.invoke).not.toHaveBeenCalled();
    store.effect = effect;
    expect(f.instance.respond(pending(f.instance).id, 'approve')).toEqual({ status: 'approved' });
    await f.events;
    expect(f.invoke).toHaveBeenCalledTimes(1);
    expect(f.invoke.mock.calls[0]?.[1].effectId).toBe(recorded);
  },
);

test('approved journal effect ID is exactly the dispatch effect ID', async () => {
  const store = new MemoryRecoveryStore();
  const f = await fixture(
    async function* ({ capabilities }) {
      await capabilities.call('write@1', { value: 1 });
      yield { type: 'output', output: null };
    },
    {},
    {},
    { create: { recovery: store } },
  );
  await opened(f.instance);
  expect([...store.journal.values()]).toEqual([]);
  f.instance.respond(pending(f.instance).id, 'approve');
  await f.events;
  const effectId = f.invoke.mock.calls[0]?.[1].effectId;
  expect(store.journal.get(JSON.stringify([f.instance.sessionId, effectId]))?.status).toBe(
    'succeeded',
  );
});

test('diagnostics, events and spans exclude arguments, confirmation IDs and host errors', async () => {
  const recorder = createSpanRecorder();
  const f = await fixture(denied(), {}, {}, { runtime: { tracerProvider: recorder.provider } });
  await opened(f.instance);
  const id = pending(f.instance).id;
  f.instance.respond(id, 'decline');
  const events = await f.events;
  await f.runtime.dispose();
  await recorder.provider.forceFlush();
  const spans = recorder.exporter.getFinishedSpans();
  assertSpanTree(spans);
  const serialized = JSON.stringify(f.diagnostics) + JSON.stringify(events) + serializeSpans(spans);
  for (const marker of [id, 'private-argument-marker', 'host-error-marker'])
    expect(serialized).not.toContain(marker);
  await recorder.provider.shutdown();
});

test('dispatch digest mismatch refuses altered approved arguments', async () => {
  const gate = new ConfirmationGate(
    { capabilities: ['write@1'], policyRevision: () => 'v1' },
    'user',
    () => {},
    () => {},
  );
  const args = { value: 1 };
  const approvalPromise = gate.request(
    'write@1',
    args,
    'effect' as never,
    'run' as never,
    new AbortController().signal,
    () => true,
    () => {},
  );
  await vi.waitFor(() => expect(gate.pending).toHaveLength(1));
  gate.respond(gate.pending?.[0]?.id as never, 'approve');
  const approval = await approvalPromise;
  args.value = 2;
  const error: unknown = await approval.check().catch((error: unknown) => error);
  expect(error).toMatchObject({ code: 'denied' });
  expect(error).not.toHaveProperty('cause');
  approval.release();
});

test('canonical approved copies reject cycles without recording their text', () => {
  const value: Record<string, unknown> = { text: 'private-argument-marker' };
  value['cycle'] = value;
  let error: unknown;
  try {
    approvedCopy(value);
  } catch (caught) {
    error = caught;
  }
  expect(error).toMatchObject({ code: 'invalid' });
  expect(error).not.toHaveProperty('cause');
  expect(String(error)).not.toContain('private-argument-marker');
});

test('expiry after approval settles a call still waiting for a concurrency slot', async () => {
  vi.useFakeTimers();
  const held = deferred<unknown>();
  const rejected = vi.fn();
  const started = vi.fn(() => held.promise);
  const f = await fixture(
    async function* ({ capabilities }) {
      const first = capabilities.call('write@1', { value: 1 });
      const second = capabilities.call('write@1', { value: 2 }).catch((error: unknown) => {
        rejected(error);
      });
      await Promise.all([first, second]);
      yield { type: 'output', output: null };
    },
    { expiresInMs: 1000 },
    { timeoutMs: 10000, invoke: started },
  );
  await opened(f.instance, 2);
  for (const entry of f.instance.getSnapshot().confirmations ?? [])
    f.instance.respond(entry.id, 'approve');
  await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1));
  await vi.advanceTimersByTimeAsync(1000);
  expect(rejected).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: 'denied' }));
  held.resolve('ok');
  await f.events;
});

test('snapshot identity is stable until confirmation publication and stale responses do not publish', async () => {
  const f = await fixture(denied());
  await opened(f.instance);
  const before = f.instance.getSnapshot();
  expect(f.instance.getSnapshot()).toBe(before);
  expect(Object.isFrozen(before)).toBe(true);
  expect(Object.isFrozen(before.confirmations)).toBe(true);
  expect(Object.isFrozen(pending(f.instance))).toBe(true);
  const published = vi.fn();
  f.instance.subscribe(published);
  expect(f.instance.respond('unknown' as never, 'approve')).toEqual({ status: 'stale' });
  expect(published).not.toHaveBeenCalled();
  expect(f.instance.getSnapshot()).toBe(before);
  f.instance.respond(pending(f.instance).id, 'decline');
  const closed = f.instance.getSnapshot();
  expect(closed).not.toBe(before);
  expect(closed.confirmations).toBeUndefined();
  expect(f.instance.getSnapshot()).toBe(closed);
  await f.events;
});

test('publication lists concurrent requests in order and removes only the answered entry', async () => {
  const f = await fixture(async function* ({ capabilities }) {
    await Promise.all([
      capabilities.call('write@1', { order: 1 }),
      capabilities.call('write@1', { order: 2 }),
    ]);
    yield { type: 'output', output: null };
  });
  await opened(f.instance, 2);
  expect(f.instance.getSnapshot().confirmations?.map((entry) => entry.arguments)).toEqual([
    { order: 1 },
    { order: 2 },
  ]);
  const [first, second] = f.instance.getSnapshot().confirmations ?? [];
  f.instance.respond(second?.id as never, 'approve');
  expect(f.instance.getSnapshot().confirmations).toEqual([first]);
  f.instance.respond(first?.id as never, 'approve');
  expect(f.instance.getSnapshot().confirmations).toBeUndefined();
  await f.events;
});

test.each([null, undefined, 1, {}, Symbol('id')])(
  'respond never throws on a bad ID: %j',
  async (id) => {
    const f = await fixture(denied());
    await opened(f.instance);
    const before = f.instance.getSnapshot();
    expect(f.instance.respond(id as never, 'approve')).toEqual({ status: 'stale' });
    expect(f.instance.getSnapshot()).toBe(before);
    f.instance.respond(pending(f.instance).id, 'decline');
    await f.events;
  },
);

test.each([null, undefined, 1, {}, 'allow', Symbol('decision')])(
  'respond never throws on a bad decision: %j',
  async (decision) => {
    const f = await fixture(denied());
    await opened(f.instance);
    const before = f.instance.getSnapshot();
    expect(f.instance.respond(pending(f.instance).id, decision as never)).toEqual({
      status: 'stale',
    });
    expect(f.instance.getSnapshot()).toBe(before);
    f.instance.respond(pending(f.instance).id, 'decline');
    await f.events;
  },
);

test('a reentrant policy callback cannot consume an approval twice', async () => {
  let reenter: (() => void) | undefined;
  const f = await fixture(
    async function* ({ capabilities }) {
      await capabilities.call('write@1', {});
      yield { type: 'output', output: null };
    },
    {
      policyRevision: () => {
        reenter?.();
        return 'v1';
      },
    },
  );
  await opened(f.instance);
  const id = pending(f.instance).id;
  const nested: unknown[] = [];
  reenter = () => {
    reenter = undefined;
    nested.push(f.instance.respond(id, 'approve'));
  };
  expect(f.instance.respond(id, 'approve')).toEqual({ status: 'approved' });
  expect(nested).toEqual([{ status: 'stale' }]);
  await f.events;
  expect(f.invoke).toHaveBeenCalledTimes(1);
});

test('budget failure removes confirmations before snapshot subscribers and abort listeners observe it', async () => {
  vi.useFakeTimers();
  const observations: unknown[] = [];
  const f = await fixture(
    async function* ({ capabilities, signal }) {
      signal.addEventListener('abort', () => observations.push(f.instance.getSnapshot()));
      await expect(capabilities.call('write@1', {})).rejects.toMatchObject({ code: 'cancelled' });
      yield { type: 'output', output: null };
    },
    {},
    {},
    { runtime: { budgets: { wallClockMs: 500 } } },
  );
  await opened(f.instance);
  const snapshots: ReturnType<typeof f.instance.getSnapshot>[] = [];
  f.instance.subscribe(() => snapshots.push(f.instance.getSnapshot()));
  await vi.advanceTimersByTimeAsync(500);
  await f.events;
  expect(snapshots.length).toBeGreaterThan(0);
  for (const snapshot of snapshots) {
    expect(snapshot.run?.status).toBe('failed');
    expect(snapshot.confirmations).toBeUndefined();
  }
  expect(observations).toEqual([f.instance.getSnapshot()]);
});

test('run completion closes unawaited confirmations without publishing stale entries', async () => {
  const finish = deferred<void>();
  const callSettled = deferred<void>();
  const f = await fixture(async function* ({ capabilities }) {
    void capabilities.call('write@1', {}).catch((error: unknown) => {
      expect(error).toMatchObject({ code: 'cancelled' });
      callSettled.resolve();
    });
    await finish.promise;
    yield { type: 'output', output: null };
  });
  await opened(f.instance);
  finish.resolve();
  await f.events;
  await callSettled.promise;
  expect(f.instance.getSnapshot().confirmations).toBeUndefined();
  expect(f.invoke).not.toHaveBeenCalled();
});
