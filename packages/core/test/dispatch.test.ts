// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { SpanStatusCode } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import { afterEach, expect, test, vi } from 'vitest';
import {
  type BudgetLimits,
  createRuntime,
  type DiagnosticEvent,
  type InteractionId,
  type PendingInteraction,
  type RunId,
  type UserInteractionEvent,
  type ViewRevision,
} from '../src/index.js';
import {
  collect,
  deferred,
  definition,
  FakeExecutor,
  flush,
  ready,
  type Script,
  stream,
} from './fake-executor.js';

const interaction: PendingInteraction = {
  interactionId: 'ask' as InteractionId,
  surfaceId: 'main',
  viewRevision: 'r1' as ViewRevision,
  component: 'tests.Question/v1',
  props: {},
};

test('dispatch accepts exactly one submission and resumes the same run', async () => {
  const { instance, executor, runtime } = await ready([
    [{ type: 'interaction', interaction }],
    [{ type: 'output', output: 'done' }],
  ]);
  Object.assign(executor.features, { resume: true });
  executor.agent.pending = async () => interaction;
  const { runId } = await instance.start('input');
  await flush();
  const event: UserInteractionEvent = {
    instanceId: instance.instanceId,
    runId,
    ...interaction,
    action: 'submit',
    payload: false,
  };
  const first = instance.dispatch(event);
  const second = instance.dispatch(event);
  await expect(first).resolves.toEqual({
    status: 'accepted',
    interactionId: interaction.interactionId,
  });
  await expect(second).resolves.toMatchObject({ status: 'rejected', error: { code: 'duplicate' } });
  await collect(instance.events(runId));
  expect(instance.getSnapshot().run).toMatchObject({
    runId,
    status: 'succeeded',
    submission: { interactionId: interaction.interactionId, status: 'consumed' },
  });
  expect(executor.requests.map((request) => request.command)).toEqual([
    { type: 'start', input: 'input' },
    { type: 'resume', interactionId: interaction.interactionId, action: 'submit', payload: false },
  ]);
  await runtime.dispose();
});

afterEach(() => vi.useRealTimers());

async function waiting(
  options: { scripts?: Script[]; budgets?: Partial<BudgetLimits>; resume?: boolean } = {},
) {
  const executor = new FakeExecutor(
    options.scripts ?? [
      [{ type: 'interaction', interaction }],
      [{ type: 'output', output: 'done' }],
    ],
  );
  Object.assign(executor.features, { resume: options.resume ?? true });
  executor.agent.pending = async () => interaction;
  const diagnostics: DiagnosticEvent[] = [];
  const runtime = createRuntime({
    appId: 'dispatch-tests',
    executors: [executor],
    ...(options.budgets === undefined ? {} : { budgets: options.budgets }),
    diagnostics: (event) => diagnostics.push(event),
  });
  const instance = await runtime.create(definition, { principalScope: 'user', agent: {} });
  await instance.prepare();
  const { runId } = await instance.start('input');
  await flush();
  const event: UserInteractionEvent = {
    instanceId: instance.instanceId,
    runId,
    ...interaction,
    action: 'submit',
    payload: { answer: true },
  };
  return { instance, executor, runtime, runId, event, diagnostics };
}

test.each(['instanceId', 'runId', 'interactionId', 'surfaceId', 'viewRevision'] as const)(
  'dispatch rejects a mismatched %s without touching the executor',
  async (field) => {
    const { instance, executor, runtime, event } = await waiting();
    await expect(instance.dispatch({ ...event, [field]: 'other' })).resolves.toMatchObject({
      status: 'rejected',
      error: { code: 'stale' },
    });
    expect(instance.getSnapshot().run?.status).toBe('waiting_input');
    expect(executor.requests).toHaveLength(1);
    await runtime.dispose();
  },
);

test('duplicate wins over status and malformed payload, but a wrong run wins over duplicate', async () => {
  const { instance, executor, runtime, event, runId } = await waiting();
  await instance.dispatch(event);
  await expect(instance.dispatch({ ...event, action: '', payload: 1n })).resolves.toMatchObject({
    status: 'rejected',
    error: { code: 'duplicate' },
  });
  await collect(instance.events(runId));
  await expect(instance.dispatch(event)).resolves.toMatchObject({
    status: 'rejected',
    error: { code: 'duplicate' },
  });
  await expect(instance.dispatch({ ...event, runId: 'old' as RunId })).resolves.toMatchObject({
    status: 'rejected',
    error: { code: 'stale' },
  });
  expect(executor.requests).toHaveLength(2);
  await runtime.dispose();
});

test.each(['running', 'succeeded'] as const)(
  'a new interaction ID while %s is stale',
  async (status) => {
    const gate = deferred<void>();
    const { instance, executor, runtime, event } = await waiting({
      scripts: [
        [{ type: 'interaction', interaction }],
        [{ wait: gate.promise }, { type: 'output', output: 'done' }],
      ],
    });
    await instance.dispatch(event);
    await flush();
    if (status === 'succeeded') {
      gate.resolve();
      await flush();
    }
    expect(instance.getSnapshot().run?.status).toBe(status);
    await expect(
      instance.dispatch({ ...event, interactionId: 'new' as InteractionId }),
    ).resolves.toMatchObject({ status: 'rejected', error: { code: 'stale' } });
    expect(executor.requests).toHaveLength(2);
    gate.resolve();
    await runtime.dispose();
  },
);

test('committed-state mismatch releases the claim for a correct retry', async () => {
  const { instance, executor, runtime, event } = await waiting();
  executor.agent.pending = async () => ({
    ...interaction,
    interactionId: 'other' as InteractionId,
  });
  await expect(instance.dispatch(event)).resolves.toMatchObject({
    status: 'rejected',
    error: { code: 'stale' },
  });
  expect(executor.requests).toHaveLength(1);
  executor.agent.pending = async () => interaction;
  await expect(instance.dispatch(event)).resolves.toMatchObject({ status: 'accepted' });
  await runtime.dispose();
});

test.each(['cancel', 'dispose'] as const)(
  '%s during committed-state validation rejects stale and waits before executor disposal',
  async (operation) => {
    const { instance, executor, runtime, event, runId } = await waiting();
    const gate = deferred<PendingInteraction>();
    executor.agent.pending = () => gate.promise;
    const receipt = instance.dispatch(event);
    const stopping = operation === 'cancel' ? instance.cancel(runId) : instance.dispose();
    await flush();
    expect(executor.disposeCalls).toBe(0);
    expect(instance.getSnapshot().run?.status).toBe('cancelled');
    gate.resolve(interaction);
    await expect(receipt).resolves.toMatchObject({ status: 'rejected', error: { code: 'stale' } });
    await stopping;
    expect(executor.requests).toHaveLength(1);
    await runtime.dispose();
    expect(executor.disposeCalls).toBe(1);
  },
);

test('a committed-state read failure returns fixed text and releases the claim', async () => {
  const { instance, executor, runtime, event, diagnostics } = await waiting();
  const raw = new Error('private-pending-canary');
  executor.agent.pending = async () => {
    throw raw;
  };
  const receipt = await instance.dispatch(event);
  expect(receipt).toEqual({
    status: 'rejected',
    error: { code: 'executor_error', message: 'The executor or agent code failed.' },
  });
  expect(JSON.stringify(receipt)).not.toContain('private-pending-canary');
  expect(diagnostics).toContainEqual(
    expect.objectContaining({ kind: 'dispatch_failed', error: raw }),
  );
  expect(diagnostics.map(({ kind }) => kind)).not.toContain('run_failed');
  expect(instance.getSnapshot().run?.status).toBe('waiting_input');
  executor.agent.pending = async () => interaction;
  await expect(instance.dispatch(event)).resolves.toMatchObject({ status: 'accepted' });
  await runtime.dispose();
});

test.each([
  { action: '', payload: null, code: 'invalid' },
  { action: 'submit', payload: 1n, code: 'invalid' },
  { action: 'submit', payload: 'x'.repeat(17), code: 'budget_exceeded' },
])('submission validation rejects $code without resuming', async ({ action, payload, code }) => {
  const { instance, executor, runtime, event } = await waiting({ budgets: { payloadBytes: 16 } });
  await expect(instance.dispatch({ ...event, action, payload })).resolves.toMatchObject({
    status: 'rejected',
    error: { code },
  });
  expect(executor.requests).toHaveLength(1);
  expect(instance.getSnapshot().run?.status).toBe('waiting_input');
  await runtime.dispose();
});

test('unsupported resume precedes submission validation', async () => {
  const { instance, executor, runtime, event } = await waiting({ resume: false });
  await expect(instance.dispatch({ ...event, action: '', payload: 1n })).resolves.toMatchObject({
    status: 'rejected',
    error: { code: 'unsupported' },
  });
  expect(executor.requests).toHaveLength(1);
  await runtime.dispose();
});

test.each(['pending', 'predecessor'] as const)(
  'resume uses the validated JSON payload when the caller mutates it during %s settlement',
  async (phase) => {
    const gate = deferred<void>();
    const { instance, executor, runtime, event, runId } = await waiting({
      budgets: { payloadBytes: 16 },
      scripts: [
        [
          { type: 'interaction', interaction },
          ...(phase === 'predecessor' ? [{ wait: gate.promise }] : []),
        ],
        [{ type: 'output', output: 'done' }],
      ],
    });
    if (phase === 'pending')
      executor.agent.pending = async () => {
        await gate.promise;
        return interaction;
      };
    const payload = { answer: '' };
    try {
      const receipt = instance.dispatch({ ...event, payload });
      if (phase === 'predecessor') expect((await receipt).status).toBe('accepted');
      payload.answer = 'x'.repeat(100);
      gate.resolve();
      expect((await receipt).status).toBe('accepted');
      await collect(instance.events(runId));
      expect(executor.requests[1]?.command).toMatchObject({
        type: 'resume',
        payload: { answer: '' },
      });
    } finally {
      gate.resolve();
      await runtime.dispose();
    }
  },
);

test('dispatch keeps the validated action and interrupt identity during JSON serialization', async () => {
  const { instance, executor, runtime, event, runId } = await waiting();
  const submission = {
    ...event,
    payload: {
      toJSON() {
        submission.action = '';
        submission.interactionId = 'other' as InteractionId;
        return { answer: true };
      },
    },
  };
  try {
    expect(await instance.dispatch(submission)).toEqual({
      status: 'accepted',
      interactionId: interaction.interactionId,
    });
    await collect(instance.events(runId));
    expect(executor.requests[1]?.command).toEqual({
      type: 'resume',
      interactionId: interaction.interactionId,
      action: 'submit',
      payload: { answer: true },
    });
  } finally {
    await runtime.dispose();
  }
});

test('accepted and consumed submission snapshots follow the executor outcome', async () => {
  const gate = deferred<void>();
  const { instance, executor, runtime, event } = await waiting({
    scripts: [
      [{ type: 'interaction', interaction }],
      [{ wait: gate.promise }, { type: 'output', output: 'done' }],
    ],
  });
  await instance.dispatch(event);
  expect(instance.getSnapshot().run).toMatchObject({
    status: 'running',
    submission: { status: 'accepted' },
  });
  expect(instance.getSnapshot().run?.pending).toBeUndefined();
  await expect(instance.start('another')).rejects.toMatchObject({ code: 'invalid' });
  gate.resolve();
  await flush();
  expect(instance.getSnapshot().run).toMatchObject({
    status: 'succeeded',
    submission: { status: 'consumed' },
  });
  expect(executor.requests).toHaveLength(2);
  await runtime.dispose();
});

test('cancelling an accepted resume before executor entry leaves the inbox accepted', async () => {
  const gate = deferred<void>();
  const { instance, executor, runtime, event, runId } = await waiting({
    scripts: [[{ type: 'interaction', interaction }, { wait: gate.promise }]],
  });
  await instance.dispatch(event);
  expect(executor.requests).toHaveLength(1);
  await instance.cancel(runId);
  expect(instance.getSnapshot().run).toMatchObject({
    status: 'cancelled',
    submission: { status: 'accepted' },
  });
  gate.resolve();
  await runtime.dispose();
  expect(executor.requests).toHaveLength(1);
});

test('resume waits for the previous iterator and spans preserve segment identity and status', async () => {
  const gate = deferred<void>();
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  const executor = new FakeExecutor([
    [{ type: 'interaction', interaction }, { wait: gate.promise }, stream('late-canary')],
    [{ type: 'output', output: 'done' }],
  ]);
  Object.assign(executor.features, { resume: true });
  executor.agent.pending = async () => interaction;
  const diagnostics: DiagnosticEvent[] = [];
  const runtime = createRuntime({
    appId: 'segments',
    executors: [executor],
    tracerProvider: provider,
    diagnostics: (event) => diagnostics.push(event),
  });
  const instance = await runtime.create(definition, { principalScope: 'user', agent: {} });
  await instance.prepare();
  const { runId } = await instance.start('input');
  await flush();
  await instance.dispatch({
    instanceId: instance.instanceId,
    runId,
    ...interaction,
    action: 'submit',
    payload: null,
  });
  await flush();
  expect(instance.getSnapshot().run?.status).toBe('running');
  expect(executor.requests).toHaveLength(1);
  gate.resolve();
  await collect(instance.events(runId));
  await flush();
  expect(executor.requests).toHaveLength(2);
  expect(diagnostics.filter((event) => event.kind === 'late_event')).toHaveLength(1);
  expect(diagnostics.some((event) => event.kind === 'protocol_violation')).toBe(false);
  const roots = exporter.getFinishedSpans().filter((span) => span.name.startsWith('invoke_agent'));
  expect(roots.map((span) => span.attributes)).toMatchObject([
    { 'galaxie.run.id': runId, 'galaxie.run.segment': 0, 'galaxie.run.status': 'waiting_input' },
    { 'galaxie.run.id': runId, 'galaxie.run.segment': 1, 'galaxie.run.status': 'succeeded' },
  ]);
  expect(roots[0]?.status.code).toBe(SpanStatusCode.UNSET);
  await runtime.dispose();
  await provider.shutdown();
});

test('one event iterator replays and follows every segment exactly once', async () => {
  const { instance, executor, runtime, event, runId } = await waiting({
    scripts: [
      [stream('before'), { type: 'interaction', interaction }],
      [stream('after'), { type: 'output', output: 'done' }],
    ],
  });
  const events = instance.events(runId)[Symbol.asyncIterator]();
  expect((await events.next()).value).toMatchObject({ type: 'interaction', sequence: 1 });
  const next = events.next();
  await instance.dispatch(event);
  expect((await next).value).toMatchObject({ type: 'stream', sequence: 2 });
  expect((await events.next()).value).toMatchObject({ type: 'output', sequence: 3 });
  expect((await events.next()).done).toBe(true);
  expect(executor.requests).toHaveLength(2);
  await runtime.dispose();
});

test('repeated preparation, subscriptions, snapshots and event reads never execute another command', async () => {
  const { instance, executor, runtime, event, runId } = await waiting();
  for (let n = 0; n < 3; n++) {
    await instance.prepare();
    const detach = instance.subscribe(() => {});
    instance.getSnapshot();
    const events = instance.events(runId)[Symbol.asyncIterator]();
    await events.next();
    await events.return?.();
    detach();
  }
  expect(executor.prepareCalls).toBe(1);
  expect(executor.requests).toHaveLength(1);
  await instance.dispatch(event);
  await collect(instance.events(runId));
  expect(executor.requests).toHaveLength(2);
  await runtime.dispose();
  await expect(instance.dispatch(event)).rejects.toMatchObject({ code: 'invalid' });
});

test.each(['interaction', 'error', 'throw'] as const)(
  'the first executor %s consumes the resumed submission',
  async (outcome) => {
    const nextInteraction = { ...interaction, interactionId: 'ask-again' as InteractionId };
    const script: Script =
      outcome === 'interaction'
        ? [{ type: 'interaction', interaction: nextInteraction }]
        : outcome === 'error'
          ? [{ type: 'error', error: { code: 'invalid', message: 'private-error-canary' } }]
          : [{ throw: new Error('private-error-canary') }];
    const { instance, executor, runtime, event } = await waiting({
      scripts: [[{ type: 'interaction', interaction }], script],
    });
    await instance.dispatch(event);
    await flush();
    expect(instance.getSnapshot().run).toMatchObject({ submission: { status: 'consumed' } });
    expect(instance.getSnapshot().run?.status).toBe(
      outcome === 'interaction' ? 'waiting_input' : 'failed',
    );
    expect(executor.requests).toHaveLength(2);
    await runtime.dispose();
  },
);

test('token reservations accumulate across segments and old segment ports close at the pause', async () => {
  let rejected: unknown;
  const executor = new FakeExecutor([
    async function* (request) {
      await request.models.begin('assistant');
      yield { type: 'interaction', interaction };
      try {
        await request.models.begin('assistant');
      } catch (error) {
        rejected = error;
      }
    },
    async function* (request) {
      await request.models.begin('assistant');
      yield { type: 'output', output: 'unreachable' };
    },
  ]);
  Object.assign(executor.features, { resume: true });
  executor.agent.pending = async () => interaction;
  const runtime = createRuntime({
    appId: 'tokens',
    executors: [executor],
    budgets: { tokens: 10 },
  });
  const instance = await runtime.create(
    { ...definition, models: { assistant: { modality: 'text' } } },
    {
      principalScope: 'user',
      agent: {},
      models: {
        providers: {
          local: {
            destination: 'in-browser',
            modality: 'text',
            features: [],
            pricing: { inputPerToken: 0, outputPerToken: 0 },
          },
        },
        roles: { assistant: { providers: ['local'], allow: ['in-browser'], maxTokens: 6 } },
      },
    },
  );
  await instance.prepare();
  const { runId } = await instance.start('input');
  await flush();
  expect(instance.getSnapshot().run?.status).toBe('waiting_input');
  expect(rejected).toMatchObject({ code: 'cancelled' });
  await instance.dispatch({
    instanceId: instance.instanceId,
    runId,
    ...interaction,
    action: 'submit',
    payload: null,
  });
  await collect(instance.events(runId));
  expect(instance.getSnapshot().run).toMatchObject({
    status: 'failed',
    error: { code: 'budget_exceeded' },
  });
  expect(executor.requests).toHaveLength(2);
  await runtime.dispose();
});

test('a new segment receives a fresh wall-clock allowance after a long human wait', async () => {
  vi.useFakeTimers();
  const gate = deferred<void>();
  const { instance, runtime, event, executor } = await waiting({
    budgets: { wallClockMs: 10 },
    scripts: [
      [{ type: 'interaction', interaction }],
      [{ wait: gate.promise }, { type: 'output', output: 'done' }],
    ],
  });
  await vi.advanceTimersByTimeAsync(100);
  expect(instance.getSnapshot().run?.status).toBe('waiting_input');
  await instance.dispatch(event);
  await vi.advanceTimersByTimeAsync(9);
  expect(instance.getSnapshot().run?.status).toBe('running');
  gate.resolve();
  await flush();
  expect(instance.getSnapshot().run?.status).toBe('succeeded');
  expect(executor.requests.map((request) => request.limits.steps)).toEqual([25, 25]);
  await runtime.dispose();
});

test('a resume that pauses again on the answered interaction fails as unsupported', async () => {
  const { instance, runtime, event, diagnostics } = await waiting({
    scripts: [[{ type: 'interaction', interaction }], [{ type: 'interaction', interaction }]],
  });
  await expect(instance.dispatch(event)).resolves.toMatchObject({ status: 'accepted' });
  await flush();
  expect(instance.getSnapshot().run).toMatchObject({
    status: 'failed',
    error: { code: 'unsupported' },
    submission: { status: 'consumed' },
  });
  expect(instance.getSnapshot().run?.pending).toBeUndefined();
  expect(diagnostics).toContainEqual(expect.objectContaining({ kind: 'protocol_violation' }));
  await runtime.dispose();
});

test('a resume iterator that ends without an outcome consumes the submission', async () => {
  const { instance, runtime, event, diagnostics } = await waiting({
    scripts: [[{ type: 'interaction', interaction }], []],
  });
  await instance.dispatch(event);
  await flush();
  expect(instance.getSnapshot().run).toMatchObject({
    status: 'failed',
    error: { code: 'executor_error' },
    submission: { status: 'consumed' },
  });
  expect(diagnostics).toContainEqual(expect.objectContaining({ kind: 'protocol_violation' }));
  await runtime.dispose();
});
