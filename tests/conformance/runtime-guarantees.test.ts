// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { createRuntime, type DiagnosticEvent } from '@galaxie/core';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import {
  binding,
  brokerFixture,
  collect,
  deferred,
  definition,
  FakeExecutor,
  flush,
  ready,
} from '../../packages/core/test/fake-executor.js';
import { assistantRoles, assistantRouting } from './support/routing.js';

afterEach(() => vi.useRealTimers());

test('two starts in one tick claim one slot before asynchronous validation', async () => {
  const validation = deferred<void>();
  const executor = new FakeExecutor();
  const runtime = createRuntime({ appId: 'double-start', executors: [executor] });
  const instance = await runtime.create(
    {
      ...definition,
      input: z.string().refine(async () => {
        await validation.promise;
        return true;
      }),
    },
    { principalScope: 'fixture', agent: {} },
  );
  try {
    await instance.prepare();
    const first = instance.start('first');
    await expect(instance.start('second')).rejects.toMatchObject({ code: 'invalid' });
    expect(instance.getSnapshot().run).toBeUndefined();
    validation.resolve();
    const { runId } = await first;
    await collect(instance.events(runId));
    expect(executor.requests).toHaveLength(1);
    expect(executor.requests[0]?.command).toEqual({ type: 'start', input: 'first' });
  } finally {
    validation.resolve();
    await runtime.dispose();
  }
});

test('repeated preparation, subscriptions, snapshots and event reads never execute another command', async () => {
  const gate = deferred<void>();
  const { instance, executor, runtime } = await ready([
    [
      { type: 'stream', executor: 'fake', path: [], mode: 'values', data: 'started' },
      { wait: gate.promise },
      { type: 'output', output: 'done' },
    ],
  ]);
  try {
    const { runId } = await instance.start('input');
    for (let count = 0; count < 3; count++) {
      await instance.prepare();
      const detach = instance.subscribe(() => {});
      instance.getSnapshot();
      const events = instance.events(runId)[Symbol.asyncIterator]();
      expect((await events.next()).value).toMatchObject({ type: 'stream' });
      await events.return?.();
      detach();
    }
    expect(executor.prepareCalls).toBe(1);
    expect(executor.requests).toHaveLength(1);
    gate.resolve();
    await collect(instance.events(runId));
    expect(executor.requests).toHaveLength(1);
  } finally {
    gate.resolve();
    await runtime.dispose();
  }
});

test('a model settlement after cancellation drops the late output and reports late_event', async () => {
  const entered = deferred<void>();
  const result = deferred<void>();
  const diagnostics: DiagnosticEvent[] = [];
  const executor = new FakeExecutor([
    async function* (request) {
      const call = await request.models.begin('assistant');
      entered.resolve();
      await result.promise;
      call.end({ inputTokens: 1, outputTokens: 1 });
      yield { type: 'output', output: 'late-model-result-canary' };
    },
  ]);
  const runtime = createRuntime({
    appId: 'late-result',
    executors: [executor],
    diagnostics: (event) => diagnostics.push(event),
  });
  const instance = await runtime.create(
    { ...definition, models: assistantRoles },
    { principalScope: 'fixture', agent: {}, models: assistantRouting() },
  );
  try {
    await instance.prepare();
    const { runId } = await instance.start('input');
    await entered.promise;
    await instance.cancel(runId);
    result.resolve();
    const events = await collect(instance.events(runId));
    await runtime.dispose();
    expect(instance.getSnapshot().run?.status).toBe('cancelled');
    expect(diagnostics.filter((event) => event.kind === 'late_event')).toHaveLength(1);
    expect(JSON.stringify({ events, snapshot: instance.getSnapshot(), diagnostics })).not.toContain(
      'late-model-result-canary',
    );
    expect(events.some((event) => event.type === 'output')).toBe(false);
  } finally {
    result.resolve();
    await runtime.dispose();
  }
});

test('toolCalls exhaustion fails the run and records the exhausted budget on its root span', async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  let calls = 0;
  const executor = new FakeExecutor([
    async function* ({ capabilities }) {
      await capabilities.call('echo@1', 'first');
      await expect(capabilities.call('echo@1', 'second')).rejects.toMatchObject({
        code: 'budget_exceeded',
      });
      yield { type: 'output', output: 'ignored' };
    },
  ]);
  const runtime = createRuntime({
    appId: 'tool-budget',
    executors: [executor],
    budgets: { toolCalls: 1 },
    tracerProvider: provider,
  });
  const instance = await runtime.create(
    {
      ...definition,
      capabilities: {
        optional: { 'echo@1': { input: z.string(), output: z.string(), kind: 'read' } },
      },
    },
    {
      principalScope: 'fixture',
      agent: {},
      bindings: {
        'echo@1': {
          ...binding(),
          invoke: async (input: string) => {
            calls++;
            return input;
          },
        },
      },
    },
  );
  try {
    await instance.prepare();
    const { runId } = await instance.start('input');
    const events = await collect(instance.events(runId));
    await runtime.dispose();
    await provider.forceFlush();
    expect(calls).toBe(1);
    expect(instance.getSnapshot().run).toMatchObject({
      status: 'failed',
      error: { code: 'budget_exceeded' },
    });
    expect(events).toMatchObject([{ type: 'error', error: { code: 'budget_exceeded' } }]);
    expect(
      exporter.getFinishedSpans().find((span) => span.name.startsWith('invoke_agent'))?.attributes,
    ).toMatchObject({
      'galaxie.budget.name': 'toolCalls',
      'galaxie.error.code': 'budget_exceeded',
    });
  } finally {
    await runtime.dispose();
    await provider.shutdown();
  }
});

test('wallClockMs expiry fails a latched executor with budget_exceeded', async () => {
  vi.useFakeTimers();
  const gate = deferred<void>();
  const executor = new FakeExecutor([[{ wait: gate.promise }]]);
  const runtime = createRuntime({
    appId: 'wall-budget',
    executors: [executor],
    budgets: { wallClockMs: 20 },
  });
  const instance = await runtime.create(definition, { principalScope: 'fixture', agent: {} });
  try {
    await instance.prepare();
    const { runId } = await instance.start('input');
    await flush();
    await vi.advanceTimersByTimeAsync(20);
    expect(instance.getSnapshot().run).toMatchObject({
      status: 'failed',
      error: { code: 'budget_exceeded' },
    });
    expect(executor.requests[0]?.signal.aborted).toBe(true);
    expect(await collect(instance.events(runId))).toMatchObject([
      { type: 'error', error: { code: 'budget_exceeded' } },
    ]);
  } finally {
    gate.resolve();
    await runtime.dispose();
  }
});

test('payloadBytes rejects an oversized capability input and fails the run', async () => {
  let calls = 0;
  const fixture = await brokerFixture({
    budgets: { payloadBytes: 8 },
    bindings: {
      'echo@1': binding({
        invoke: async (input) => {
          calls++;
          return input;
        },
      }),
    },
    scripts: [
      async function* ({ capabilities }) {
        await expect(capabilities.call('echo@1', 'ééééé')).rejects.toMatchObject({
          code: 'budget_exceeded',
        });
        yield { type: 'output', output: 'ignored' };
      },
    ],
  });
  try {
    const { runId } = await fixture.instance.start('input');
    const events = await collect(fixture.instance.events(runId));
    await fixture.runtime.dispose();
    expect(fixture.scriptErrors).toEqual([]);
    expect(calls).toBe(0);
    expect(fixture.instance.getSnapshot().run).toMatchObject({
      status: 'failed',
      error: { code: 'budget_exceeded' },
    });
    expect(events).toMatchObject([{ type: 'error', error: { code: 'budget_exceeded' } }]);
  } finally {
    await fixture.runtime.dispose();
  }
});
