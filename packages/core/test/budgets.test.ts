// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { budgetLimits, RunBudget } from '../src/budgets.js';
import { createRuntime, DEFAULT_BUDGETS } from '../src/index.js';
import {
  binding,
  brokerFixture,
  collect,
  deferred,
  definition,
  FakeExecutor,
  flush,
} from './fake-executor.js';

afterEach(() => vi.useRealTimers());
test('finite defaults equal the R20 table', () => {
  expect(DEFAULT_BUDGETS).toEqual({
    steps: 25,
    toolCalls: 50,
    wallClockMs: 300000,
    payloadBytes: 1048576,
    tokens: 100000,
    cost: 0,
    repairAttempts: 2,
    uiElements: 50,
  });
});
test.each([
  { steps: 0 },
  { steps: -1 },
  { steps: 1.5 },
  { toolCalls: Infinity },
  { tokens: NaN },
  { cost: -1 },
  { payloadBytes: 1.5 },
  { repairAttempts: -1 },
  { uiElements: 0.1 },
  { wallClockMs: -1 },
])('invalid budgets reject at runtime creation: %j', (budgets) => {
  expect(() => createRuntime({ appId: 'test', executors: [], budgets })).toThrowError(
    expect.objectContaining({ code: 'invalid' }),
  );
});
test('AE3 toolCalls exhaustion is fatal even if the graph catches the third rejection', async () => {
  const invoke = vi.fn(async (input: unknown) => input);
  const fixture = await brokerFixture({
    budgets: { toolCalls: 2 },
    bindings: { 'echo@1': binding({ invoke }) },
    scripts: [
      async function* ({ capabilities }) {
        await capabilities.call('echo@1', 'first');
        await capabilities.call('echo@1', 'second');
        await expect(capabilities.call('echo@1', 'third')).rejects.toMatchObject({
          code: 'budget_exceeded',
        });
        yield { type: 'output', output: 'ignored' };
      },
    ],
  });
  const { runId } = await fixture.instance.start('input');
  const events = await collect(fixture.instance.events(runId));
  await fixture.runtime.dispose();
  expect(fixture.scriptErrors).toEqual([]);
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(fixture.executor.requests[0]?.signal.aborted).toBe(true);
  expect(fixture.instance.getSnapshot().run).toMatchObject({
    status: 'failed',
    error: { code: 'budget_exceeded' },
  });
  expect(events).toMatchObject([{ type: 'error', error: { code: 'budget_exceeded' } }]);
});
test.each(['input', 'output'] as const)(
  '%s UTF-8 JSON payload limit fails the run',
  async (side) => {
    const invoke = vi.fn(async (input: unknown) => (side === 'output' ? 'ééééé' : input));
    const fixture = await brokerFixture({
      budgets: { payloadBytes: 8 },
      bindings: { 'echo@1': binding({ invoke }) },
      scripts: [
        async function* ({ capabilities }) {
          await expect(
            capabilities.call('echo@1', side === 'input' ? 'ééééé' : 'x'),
          ).rejects.toMatchObject({ code: 'budget_exceeded' });
          yield { type: 'output', output: null };
        },
      ],
    });
    const { runId } = await fixture.instance.start('input');
    await collect(fixture.instance.events(runId));
    await fixture.runtime.dispose();
    expect(fixture.scriptErrors).toEqual([]);
    expect(fixture.instance.getSnapshot().run?.error?.code).toBe('budget_exceeded');
    expect(invoke).toHaveBeenCalledTimes(side === 'input' ? 0 : 1);
  },
);
test('denials and invalid input do not reserve tool calls', async () => {
  const fixture = await brokerFixture({
    budgets: { toolCalls: 1 },
    scripts: [
      async function* ({ capabilities }) {
        await expect(capabilities.call('missing@1', 'x')).rejects.toMatchObject({ code: 'denied' });
        await expect(capabilities.call('echo@1', 1)).rejects.toMatchObject({ code: 'invalid' });
        await expect(capabilities.call('echo@1', 'ok')).resolves.toBe('ok');
        yield { type: 'output', output: null };
      },
    ],
  });
  const { runId } = await fixture.instance.start('input');
  await collect(fixture.instance.events(runId));
  await fixture.runtime.dispose();
  expect(fixture.scriptErrors).toEqual([]);
  expect(fixture.instance.getSnapshot().run?.status).toBe('succeeded');
});
test('wall-clock expiry fails and closes the root span while the executor is hanging', async () => {
  vi.useFakeTimers();
  const gate = deferred<void>();
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  const executor = new FakeExecutor([[{ wait: gate.promise }]]);
  const runtime = createRuntime({
    appId: 'test',
    executors: [executor],
    budgets: { wallClockMs: 20 },
    tracerProvider: provider,
  });
  const instance = await runtime.create(definition, { principalScope: 'user', agent: {} });
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
  expect(exporter.getFinishedSpans()).toHaveLength(1);
  expect(exporter.getFinishedSpans()[0]?.attributes).toMatchObject({
    'galaxie.error.code': 'budget_exceeded',
    'galaxie.budget.name': 'wallClockMs',
  });
  gate.resolve();
  await runtime.dispose();
});
test('executor budget events preserve the recursion type and record the steps budget', async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  const executor = new FakeExecutor([
    [
      {
        type: 'error',
        error: { code: 'budget_exceeded', message: 'raw', type: 'GraphRecursionError' },
      },
    ],
  ]);
  const runtime = createRuntime({ appId: 'test', executors: [executor], tracerProvider: provider });
  const instance = await runtime.create(
    { ...definition, input: z.string() },
    { principalScope: 'user', agent: {} },
  );
  await instance.prepare();
  const { runId } = await instance.start('input');
  await collect(instance.events(runId));
  await runtime.dispose();
  expect(exporter.getFinishedSpans()[0]?.attributes).toMatchObject({
    'galaxie.error.code': 'budget_exceeded',
    'galaxie.budget.name': 'steps',
    'error.type': 'GraphRecursionError',
  });
});

test('model reservations check tokens first and release atomically when cost cannot fit', () => {
  const budget = new RunBudget(budgetLimits({ tokens: 10, cost: 5 }));
  expect(() => budget.reserveModel(11, 6)).toThrowError(
    expect.objectContaining({ budget: 'tokens' }),
  );
  expect(() => budget.reserveModel(10, 6)).toThrowError(
    expect.objectContaining({ budget: 'cost' }),
  );
  const reservation = budget.reserveModel(10, 5);
  reservation.release();
  reservation.release();
  expect(() => budget.reserveModel(10, 5)).not.toThrow();
});
test('model settlement replaces a reservation with its actual charge only once', () => {
  const budget = new RunBudget(budgetLimits({ tokens: 10, cost: 5 }));
  const first = budget.reserveModel(8, 4);
  first.settle(2, 1);
  first.settle(8, 4);
  first.release();
  expect(() => budget.reserveModel(8, 4)).not.toThrow();
});
test('model cost accounting compares the unrounded float charge', () => {
  const budget = new RunBudget(budgetLimits({ cost: 0.3 }));
  const reservation = budget.reserveModel(1, 0.1);
  expect(() => reservation.settle(1, 0.1 + 0.2)).toThrowError(
    expect.objectContaining({ budget: 'cost' }),
  );
});

test('released fractional reservations leave exactly the remaining live cost', () => {
  const budget = new RunBudget(budgetLimits({ cost: 0.31 }));
  const first = budget.reserveModel(1, 0.1);
  const second = budget.reserveModel(1, 0.2);
  first.release();
  const third = budget.reserveModel(1, 0.11);
  second.release();
  third.release();
  expect(() => budget.reserveModel(1, 0.31)).not.toThrow();
});
test('all released fractional reservations permit the exact full budget again', () => {
  const budget = new RunBudget(budgetLimits({ cost: 0.31 }));
  const first = budget.reserveModel(1, 0.1);
  const second = budget.reserveModel(1, 0.2);
  first.release();
  second.release();
  expect(() => budget.reserveModel(1, 0.31)).not.toThrow();
});
