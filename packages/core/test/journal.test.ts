// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import {
  type AgentDefinition,
  type CapabilityBinding,
  type CapabilityContext,
  createRuntime,
  type DiagnosticEvent,
  galaxieField,
  type InteractionId,
  isGalaxieError,
  type PendingInteraction,
  type RunRequest,
  type Schema,
  type SessionId,
  toErrorInfo,
  type ViewRevision,
} from '../src/index.js';
import { binding, collect, deferred, definition, FakeExecutor, flush } from './fake-executor.js';
import { MemoryRecoveryStore } from './support/memory-recovery-store.js';

const sessionId = 'f03855d0-093d-44ef-afdd-58bff38d34dc' as SessionId;
const interaction: PendingInteraction = {
  interactionId: 'journal-answer' as InteractionId,
  surfaceId: 'main',
  viewRevision: 'r1' as ViewRevision,
  component: 'tests.Question/v1',
  props: {},
};
const runtimes: Array<{ dispose(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
});

async function acceptedStore(): Promise<MemoryRecoveryStore> {
  const store = new MemoryRecoveryStore();
  await store.acceptSubmission(sessionId, {
    interactionId: interaction.interactionId,
    action: 'submit',
    payload: { answer: 'private learner answer' },
  });
  return store;
}

async function resume(
  store: MemoryRecoveryStore,
  invoke: CapabilityBinding['invoke'],
  execute: (request: RunRequest) => Promise<unknown> = (request) =>
    request.capabilities.call('write@1', 'first'),
  options: {
    retry?: CapabilityBinding['retry'];
    kind?: CapabilityBinding['kind'];
    input?: Schema;
    output?: Schema;
    destination?: CapabilityBinding['destination'];
  } = {},
) {
  const errors: unknown[] = [];
  const executor = new FakeExecutor([
    async function* (request) {
      try {
        yield { type: 'output', output: await execute(request) };
      } catch (error) {
        errors.push(error);
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
    appId: 'journal-tests',
    executors: [executor],
    diagnostics: (event) => diagnostics.push(event),
  });
  runtimes.push(runtime);
  const kind = options.kind ?? 'write';
  const agentDefinition: AgentDefinition = {
    ...definition,
    capabilities: {
      optional: {
        'write@1': {
          input: options.input ?? z.string(),
          output: options.output ?? z.object({ receipt: z.string() }),
          kind,
        },
      },
    },
  };
  const instance = await runtime.create(agentDefinition, {
    principalScope: 'user',
    sessionId,
    agent: {},
    recovery: store,
    bindings: {
      'write@1': binding({
        kind,
        retry: options.retry ?? 'none',
        destination: options.destination ?? 'in-browser',
        invoke,
      }),
    },
  });
  await store.recordSession(sessionId, {
    agentId: definition.id,
    agentVersion: definition.version,
    executorId: 'fake',
  });
  await instance.prepare();
  await instance.restore();
  return { runtime, instance, executor, diagnostics, errors };
}

async function crashAfterResult(
  store: MemoryRecoveryStore,
  invoke: CapabilityBinding['invoke'],
  execute: (request: RunRequest) => Promise<unknown> = (request) =>
    request.capabilities.call('write@1', 'first'),
  options: Parameters<typeof resume>[3] = {},
): Promise<void> {
  const gotResult = deferred<void>();
  const first = await resume(
    store,
    invoke,
    async (request) => {
      await execute(request);
      gotResult.resolve();
      await new Promise<void>((resolve) =>
        request.signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      return 'late';
    },
    options,
  );
  await gotResult.promise;
  await first.runtime.dispose();
}

test('task scope ordinals replay independently of interleaved task call order', async () => {
  const store = await acceptedStore();
  const contexts: CapabilityContext[] = [];
  const invoke: CapabilityBinding['invoke'] = async (_input, context) => {
    contexts.push(context);
    return { receipt: context.effectId };
  };
  await crashAfterResult(store, invoke, async ({ capabilities }) => {
    await capabilities.call('write@1', 'first', { effectScope: 'parent:task-1' });
    await capabilities.call('write@1', 'child', { effectScope: 'parent:task-1|child:task-2' });
    await capabilities.call('write@1', 'second', { effectScope: 'parent:task-1' });
  });
  expect(contexts).toHaveLength(3);
  expect(new Set(contexts.map(({ effectId }) => effectId)).size).toBe(3);
  const reads = vi.spyOn(store, 'effect');
  const restored = await resume(store, invoke, async ({ capabilities }) => [
    await capabilities.call('write@1', 'child', { effectScope: 'parent:task-1|child:task-2' }),
    await capabilities.call('write@1', 'first', { effectScope: 'parent:task-1' }),
    await capabilities.call('write@1', 'second', { effectScope: 'parent:task-1' }),
    await capabilities.call('write@1', 'first', { effectScope: 'parent:task-3' }),
  ]);
  await vi.waitFor(() => expect(restored.instance.getSnapshot().run?.status).toBe('succeeded'));
  expect(contexts).toHaveLength(4);
  expect(new Set(contexts.map(({ effectId }) => effectId)).size).toBe(4);
  expect(reads.mock.calls.map(([, effectId]) => effectId)).toEqual([
    contexts[1]?.effectId,
    contexts[0]?.effectId,
    contexts[2]?.effectId,
    contexts[3]?.effectId,
  ]);
  const runId = restored.instance.getSnapshot().run?.runId;
  if (runId === undefined) throw new Error('Expected the restored run.');
  expect((await collect(restored.instance.events(runId))).at(-1)).toMatchObject({
    type: 'output',
    output: [contexts[1], contexts[0], contexts[2], contexts[3]].map((context) => ({
      receipt: context?.effectId,
    })),
  });
});

test('unscoped writes retain the resume segment identity and differ from start', async () => {
  const store = await acceptedStore();
  const contexts: CapabilityContext[] = [];
  const invoke: CapabilityBinding['invoke'] = async (_input, context) => {
    contexts.push(context);
    return { receipt: context.effectId };
  };
  await crashAfterResult(store, invoke);
  const restored = await resume(store, invoke, async ({ capabilities }) => [
    await capabilities.call('write@1', 'first', { effectScope: interaction.interactionId }),
    await capabilities.call('write@1', 'first', { effectScope: 'start' }),
  ]);
  await vi.waitFor(() => expect(restored.instance.getSnapshot().run?.status).toBe('succeeded'));
  expect(contexts).toHaveLength(2);
  expect(contexts[0]?.effectId).not.toBe(contexts[1]?.effectId);
  const runId = restored.instance.getSnapshot().run?.runId;
  if (runId === undefined) throw new Error('Expected the restored run.');
  expect((await collect(restored.instance.events(runId))).at(-1)).toMatchObject({
    type: 'output',
    output: contexts.map(({ effectId }) => ({ receipt: effectId })),
  });
});

test('a succeeded write receipt survives a crash before the resume checkpoint', async () => {
  const store = await acceptedStore();
  const invoked: CapabilityContext[] = [];
  const invoke: CapabilityBinding['invoke'] = async (_input, context) => {
    invoked.push(context);
    return { receipt: 'stored receipt' };
  };
  const gotResult = deferred<void>();
  const first = await resume(store, invoke, async (request) => {
    await request.capabilities.call('write@1', 'first');
    gotResult.resolve();
    await new Promise<void>((resolve) => request.signal.addEventListener('abort', () => resolve()));
    return 'late';
  });
  await gotResult.promise;
  expect([...store.journal.values()]).toEqual([
    {
      status: 'succeeded',
      inputDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      output: { receipt: 'stored receipt' },
    },
  ]);
  await first.runtime.dispose();
  const restored = await resume(store, invoke);
  await vi.waitFor(() => expect(restored.instance.getSnapshot().run?.status).toBe('succeeded'));
  expect(invoked).toHaveLength(1);
  expect(invoked[0]?.effectId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
});

test('a failed resume keeps its answer accepted and replays the succeeded write once', async () => {
  const store = await acceptedStore();
  const invoke = vi.fn(async () => ({ receipt: 'stored receipt' }));
  const first = await resume(store, invoke, async (request) => {
    await request.capabilities.call('write@1', 'first');
    throw new Error('private graph failure');
  });
  await vi.waitFor(() => expect(first.instance.getSnapshot().run?.status).toBe('failed'));
  expect((await store.submissions(sessionId))[0]?.status).toBe('accepted');
  await first.runtime.dispose();
  const restored = await resume(store, invoke);
  await vi.waitFor(() => expect(restored.instance.getSnapshot().run?.status).toBe('succeeded'));
  expect(invoke).toHaveBeenCalledTimes(1);
  expect((await store.submissions(sessionId))[0]?.status).toBe('consumed');
  expect(restored.executor.requests).toHaveLength(1);
  expect(restored.executor.requests[0]?.command).toMatchObject({
    type: 'resume',
    interactionId: interaction.interactionId,
    payload: { answer: 'private learner answer' },
  });
});

test.each(['none', 'idempotent', 'idempotency-key'] as const)(
  'a dispatched write after a crash obeys retry %s',
  async (retry) => {
    const store = await acceptedStore();
    const invoked: CapabilityContext[] = [];
    const entered = deferred<void>();
    const invoke: CapabilityBinding['invoke'] = async (_input, context) => {
      invoked.push(context);
      if (invoked.length > 1) return { receipt: 'retried receipt' };
      entered.resolve();
      return new Promise((_resolve, reject) =>
        context.signal.addEventListener('abort', () => reject(new Error('host private failure'))),
      );
    };
    const first = await resume(store, invoke, undefined, { retry });
    await entered.promise;
    expect([...store.journal.values()][0]?.status).toBe('dispatched');
    await first.runtime.dispose();
    expect([...store.journal.values()][0]?.status).toBe('outcome_unknown');
    const restored = await resume(store, invoke, undefined, { retry });
    await vi.waitFor(() =>
      expect(restored.instance.getSnapshot().run?.status).toBe(
        retry === 'none' ? 'failed' : 'succeeded',
      ),
    );
    if (retry === 'none') {
      expect(invoked).toHaveLength(1);
      expect(restored.errors[0]).toMatchObject({
        code: 'outcome_unknown',
        message: 'The outcome of an earlier call is unknown.',
      });
      expect(restored.errors[0]).not.toHaveProperty('cause');
      expect(restored.diagnostics).toContainEqual({
        instanceId: restored.instance.instanceId,
        runId: restored.instance.getSnapshot().run?.runId,
        kind: 'effect_outcome_unknown',
        effectId: invoked[0]?.effectId,
      });
    } else {
      expect(invoked).toHaveLength(2);
      expect(invoked[1]?.effectId).toBe(invoked[0]?.effectId);
    }
  },
);

test('reads keep fresh effect IDs and never touch the journal', async () => {
  const store = await acceptedStore();
  const read = vi.spyOn(store, 'effect');
  const write = vi.spyOn(store, 'recordEffect');
  const contexts: CapabilityContext[] = [];
  const fixture = await resume(
    store,
    async (_input, context) => {
      contexts.push(context);
      return { receipt: 'read result' };
    },
    async (request) => {
      await request.capabilities.call('write@1', 'first');
      return request.capabilities.call('write@1', 'first');
    },
    { kind: 'read' },
  );
  await vi.waitFor(() => expect(fixture.instance.getSnapshot().run?.status).toBe('succeeded'));
  expect(contexts).toHaveLength(2);
  expect(contexts[0]?.effectId).not.toBe(contexts[1]?.effectId);
  expect(read).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});

test('changed input order for the same capability fails before invoking or returning a receipt', async () => {
  const store = await acceptedStore();
  const invoke = vi.fn(async () => ({ receipt: 'receipt' }));
  await crashAfterResult(store, invoke, async (request) => {
    await request.capabilities.call('write@1', 'first');
    return request.capabilities.call('write@1', 'second');
  });
  expect(invoke).toHaveBeenCalledTimes(2);
  const restored = await resume(store, invoke, (request) =>
    request.capabilities.call('write@1', 'second'),
  );
  await vi.waitFor(() => expect(restored.instance.getSnapshot().run?.status).toBe('failed'));
  expect(restored.errors[0]).toMatchObject({ code: 'unrecoverable' });
  expect(invoke).toHaveBeenCalledTimes(2);
  expect([...store.journal.values()].every((record) => record.status === 'succeeded')).toBe(true);
});

test('journal receipts are fresh copies of post-validation output on replay', async () => {
  const store = await acceptedStore();
  const invoke = vi.fn(async () => ({ receipt: 'original' }));
  const transform = vi.fn((value: { receipt: string }) => ({
    receipt: `${value.receipt} transformed`,
  }));
  const options = { output: z.object({ receipt: z.string() }).transform(transform) };
  await crashAfterResult(
    store,
    invoke,
    async (request) => {
      const output = (await request.capabilities.call('write@1', 'first')) as { receipt: string };
      expect(output).toEqual({ receipt: 'original transformed' });
      output.receipt = 'mutated first result';
    },
    options,
  );
  const restored = await resume(
    store,
    invoke,
    async (request) => {
      const output = (await request.capabilities.call('write@1', 'first')) as { receipt: string };
      expect(output).toEqual({ receipt: 'original transformed' });
      output.receipt = 'mutated replay result';
      return 'done';
    },
    options,
  );
  await vi.waitFor(() => expect(restored.instance.getSnapshot().run?.status).toBe('succeeded'));
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(transform).toHaveBeenCalledTimes(1);
  expect([...store.journal.values()][0]).toMatchObject({
    output: { receipt: 'original transformed' },
  });
});

test('replaying a receipt re-registers its private output strings before later calls', async () => {
  const store = await acceptedStore();
  const invoke = vi.fn(async () => ({ receipt: 'private receipt' }));
  const options = {
    input: z.enum(['first', 'private receipt']),
    output: z.object({
      receipt: z.string().meta(galaxieField({ label: 'private-user', shape: 'freeText' })),
    }),
    destination: 'host-server' as const,
  };
  await crashAfterResult(store, invoke, undefined, options);
  const restored = await resume(
    store,
    invoke,
    async (request) => {
      await request.capabilities.call('write@1', 'first');
      return request.capabilities.call('write@1', 'private receipt');
    },
    options,
  );
  await vi.waitFor(() => expect(restored.instance.getSnapshot().run?.status).toBe('failed'));
  expect(restored.errors[0]).toMatchObject({ code: 'denied' });
  expect(invoke).toHaveBeenCalledTimes(1);
});

test.each(['read', 'planned', 'dispatched'] as const)(
  'journal failure at %s fails unavailable before invoking',
  async (boundary) => {
    const store = await acceptedStore();
    const invoke = vi.fn(async () => ({ receipt: 'unused' }));
    if (boundary === 'read') {
      vi.spyOn(store, 'effect').mockRejectedValue(new Error('private storage failure'));
    } else {
      const write = store.recordEffect.bind(store);
      store.recordEffect = async (...args) => {
        if (args[2].status === boundary) throw new Error('private storage failure');
        await write(...args);
      };
    }
    const fixture = await resume(store, invoke);
    await vi.waitFor(() => expect(fixture.instance.getSnapshot().run?.status).toBe('failed'));
    expect(fixture.errors[0]).toMatchObject({ code: 'unavailable' });
    expect(invoke).not.toHaveBeenCalled();
    expect(fixture.diagnostics.filter((event) => event.kind === 'capability_failed')).toEqual([
      expect.not.objectContaining({ error: expect.anything() }),
    ]);
  },
);

test('a failed succeeded write returns the validated result without exposing it in diagnostics', async () => {
  const store = await acceptedStore();
  const write = store.recordEffect.bind(store);
  store.recordEffect = async (...args) => {
    if (args[2].status === 'succeeded') throw new Error('private result storage failure');
    await write(...args);
  };
  const fixture = await resume(store, async () => ({ receipt: 'private receipt' }));
  await vi.waitFor(() => expect(fixture.instance.getSnapshot().run?.status).toBe('succeeded'));
  const runId = fixture.instance.getSnapshot().run?.runId;
  if (runId === undefined) throw new Error('The journal run is missing.');
  expect(await collect(fixture.instance.events(runId))).toContainEqual(
    expect.objectContaining({ type: 'output', output: { receipt: 'private receipt' } }),
  );
  expect([...store.journal.values()][0]?.status).toBe('dispatched');
  expect(fixture.diagnostics).toEqual([
    {
      instanceId: fixture.instance.instanceId,
      runId: fixture.instance.getSnapshot().run?.runId,
      kind: 'capability_failed',
    },
  ]);
});

test.each([false, true])(
  'abort cannot overwrite a started succeeded write (store rejects: %s)',
  async (reject) => {
    const store = await acceptedStore();
    const started = deferred<void>();
    const release = deferred<void>();
    const writes: string[] = [];
    const write = store.recordEffect.bind(store);
    store.recordEffect = async (...args) => {
      writes.push(args[2].status);
      if (args[2].status === 'succeeded') {
        started.resolve();
        await release.promise;
        if (reject) throw new Error('private storage failure');
      }
      await write(...args);
    };
    const fixture = await resume(store, async () => ({ receipt: 'private receipt' }));
    await started.promise;
    const disposing = fixture.runtime.dispose();
    await flush();
    expect(writes).toEqual(['planned', 'dispatched', 'succeeded']);
    release.resolve();
    await disposing;
    expect([...store.journal.values()][0]?.status).toBe(reject ? 'dispatched' : 'succeeded');
    expect(writes).toEqual(['planned', 'dispatched', 'succeeded']);
    if (reject)
      expect(fixture.diagnostics).toContainEqual({
        instanceId: fixture.instance.instanceId,
        runId: fixture.instance.getSnapshot().run?.runId,
        kind: 'capability_failed',
      });
  },
);

test('cancellation while planned records failed without dispatching the write', async () => {
  const store = await acceptedStore();
  const planned = deferred<void>();
  const release = deferred<void>();
  const write = store.recordEffect.bind(store);
  store.recordEffect = async (...args) => {
    await write(...args);
    if (args[2].status === 'planned') {
      planned.resolve();
      await release.promise;
    }
  };
  const invoke = vi.fn(async () => ({ receipt: 'unused' }));
  const fixture = await resume(store, invoke);
  await planned.promise;
  const runId = fixture.instance.getSnapshot().run?.runId;
  if (runId === undefined) throw new Error('Missing run');
  await fixture.instance.cancel(runId);
  release.resolve();
  await fixture.runtime.dispose();
  expect([...store.journal.values()][0]?.status).toBe('failed');
  expect(invoke).not.toHaveBeenCalled();
});

test.each(['reject', 'invalid-output'] as const)(
  'a host %s after dispatch leaves outcome_unknown',
  async (mode) => {
    const store = await acceptedStore();
    const fixture = await resume(store, async () => {
      if (mode === 'reject') throw new Error('host private failure');
      return { receipt: 123 };
    });
    await vi.waitFor(() => expect(fixture.instance.getSnapshot().run?.status).toBe('failed'));
    expect([...store.journal.values()][0]?.status).toBe('outcome_unknown');
    expect(fixture.errors[0]).not.toHaveProperty('cause');
  },
);

test('malformed stored journal records fail unrecoverable without invoking', async () => {
  const store = await acceptedStore();
  vi.spyOn(store, 'effect').mockResolvedValue({
    status: 'succeeded',
    output: 'private corrupt value',
  } as never);
  const invoke = vi.fn();
  const fixture = await resume(store, invoke);
  await vi.waitFor(() => expect(fixture.instance.getSnapshot().run?.status).toBe('failed'));
  expect(fixture.errors[0]).toMatchObject({ code: 'unrecoverable' });
  expect(invoke).not.toHaveBeenCalled();
  expect(store.journal.size).toBe(0);
});

test.each(['read', 'planned', 'dispatched', 'succeeded'] as const)(
  'maps a fenced journal %s failure with no cause or host text',
  async (phase) => {
    const store = await acceptedStore();
    const fenced = (): never => {
      throw Object.assign(new Error('private-fenced-journal'), { fenced: true });
    };
    if (phase === 'read') store.effect = async () => fenced();
    else {
      const record = store.recordEffect.bind(store);
      store.recordEffect = async (...args) => {
        if (args[2].status === phase) fenced();
        await record(...args);
      };
    }
    const invoke = vi.fn(async () => ({ receipt: 'private reply' }));
    const fixture = await resume(store, invoke);
    await vi.waitFor(() => expect(fixture.instance.getSnapshot().run?.status).toBe('failed'));
    expect(fixture.errors[0]).toMatchObject({
      code: 'fenced',
      message: 'Another owner controls the runtime.',
    });
    expect(fixture.errors[0]).not.toHaveProperty('cause');
    expect(JSON.stringify(fixture.instance.getSnapshot())).not.toContain('private-fenced-journal');
    expect(JSON.stringify(fixture.instance.getSnapshot())).not.toContain('private reply');
    expect(invoke).toHaveBeenCalledTimes(phase === 'succeeded' ? 1 : 0);
  },
);
