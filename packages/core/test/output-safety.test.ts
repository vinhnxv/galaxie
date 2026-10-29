// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test, vi } from 'vitest';
import { budgetLimits, RunBudget } from '../src/budgets.js';
import { createRuntime, type DiagnosticEvent, type OutputSafetyHook } from '../src/index.js';
import { ModelRouter, type ModelRun } from '../src/model-router.js';
import { DEFAULT_DATA_POLICY } from '../src/policy.js';
import { deferred, definition, FakeExecutor } from './fake-executor.js';

const sentinel = 'checked-output-canary-92bf';
const models = {
  providers: {
    local: {
      destination: 'in-browser' as const,
      modality: 'text' as const,
      features: [],
      pricing: { inputPerToken: 0, outputPerToken: 0 },
    },
  },
  roles: { assistant: { providers: ['local'], allow: ['in-browser' as const], maxTokens: 100 } },
};
const routed = { ...definition, models: { assistant: { modality: 'text' as const } } };

async function fixture(hook?: OutputSafetyHook): Promise<{
  call: Awaited<ReturnType<ReturnType<ModelRouter['port']>['begin']>>;
  controller: AbortController;
  diagnostics: Omit<DiagnosticEvent, 'instanceId'>[];
}> {
  const controller = new AbortController();
  const diagnostics: Omit<DiagnosticEvent, 'instanceId'>[] = [];
  const router = new ModelRouter(
    routed,
    models,
    DEFAULT_DATA_POLICY,
    (event) => diagnostics.push(event),
    hook,
  );
  const run: ModelRun = {
    runId: 'run' as ModelRun['runId'],
    signal: controller.signal,
    labels: new Set(),
    budget: new RunBudget(budgetLimits()),
    active: () => !controller.signal.aborted,
    failBudget: () => {},
    selectedRouteChanged: () => {},
  };
  return { call: await router.port(run).begin('assistant'), controller, diagnostics };
}

test.each([null, true, 1, 'allow', {}])(
  'rejects a non-function output safety hook: %j',
  (outputSafety) => {
    expect(() =>
      createRuntime({ appId: 'test', executors: [], outputSafety: outputSafety as never }),
    ).toThrowError(expect.objectContaining({ code: 'invalid' }));
  },
);

test('an unset hook resolves and reports once per routed instance at create', async () => {
  const { call } = await fixture();
  await expect(call.checkOutput(sentinel, { final: true })).resolves.toBeUndefined();
  expect(call.outputSafetyOutcome).toBe('unset');
  const diagnostics: DiagnosticEvent[] = [];
  const runtime = createRuntime({
    appId: 'test',
    executors: [new FakeExecutor()],
    diagnostics: (event) => diagnostics.push(event),
  });
  const first = await runtime.create(routed, { agent: {}, principalScope: 'user', models });
  await first.prepare();
  await first.prepare();
  const second = await runtime.create(routed, { agent: {}, principalScope: 'user', models });
  await runtime.create(definition, { agent: {}, principalScope: 'user' });
  expect(diagnostics).toEqual([
    { kind: 'output_safety_unset', instanceId: first.instanceId },
    { kind: 'output_safety_unset', instanceId: second.instanceId },
  ]);
  await runtime.dispose();
});

test('allow receives the call context and records the last outcome', async () => {
  const hook = vi.fn<OutputSafetyHook>(() => 'allow');
  const { call, controller, diagnostics } = await fixture(hook);
  await call.checkOutput(sentinel, { final: false });
  await call.checkOutput(`${sentinel} complete`, { final: true });
  expect(hook.mock.calls.map(([check]) => check)).toEqual([
    {
      text: sentinel,
      final: false,
      role: 'assistant',
      destination: 'in-browser',
      signal: controller.signal,
    },
    {
      text: `${sentinel} complete`,
      final: true,
      role: 'assistant',
      destination: 'in-browser',
      signal: controller.signal,
    },
  ]);
  expect(call.outputSafetyOutcome).toBe('allowed');
  expect(diagnostics).toEqual([]);
});

test.each(['block', 'throw', 'reject', 'invalid'] as const)(
  'fails closed without checked or host error text: %s',
  async (mode) => {
    const hook = vi.fn<OutputSafetyHook>(() => {
      if (mode === 'throw') throw new Error(sentinel);
      if (mode === 'reject') return Promise.reject(new Error(sentinel));
      return (mode === 'invalid' ? 'yes' : 'block') as 'block';
    });
    const { call, diagnostics } = await fixture(hook);
    const blocked = mode === 'block';
    for (let attempt = 0; attempt < 2; attempt++) {
      const error = await call
        .checkOutput(sentinel, { final: true })
        .catch((error: unknown) => error);
      expect(error).toMatchObject({
        name: 'GalaxieError',
        code: blocked ? 'denied' : 'unavailable',
        message: blocked
          ? 'The output safety hook blocked the reply.'
          : 'The output safety hook failed.',
      });
      expect(error).not.toHaveProperty('cause');
      expect(JSON.stringify(error)).not.toContain(sentinel);
      expect(String(error)).not.toContain(sentinel);
    }
    expect(hook).toHaveBeenCalledTimes(1);
    expect(call.outputSafetyOutcome).toBe(blocked ? 'blocked' : 'failed');
    expect(diagnostics).toEqual([
      { kind: blocked ? 'output_blocked' : 'output_safety_failed', runId: 'run' },
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain(sentinel);
  },
);

test.each(['before', 'during'] as const)(
  'cancels a safety check %s the host wait',
  async (when) => {
    const entered = deferred<AbortSignal>();
    const pending = deferred<'allow'>();
    const hook = vi.fn<OutputSafetyHook>((check) => {
      entered.resolve(check.signal);
      return pending.promise;
    });
    const { call, controller, diagnostics } = await fixture(hook);
    if (when === 'before') controller.abort();
    const check = call.checkOutput(sentinel, { final: true });
    const rejected = expect(check).rejects.toMatchObject({ code: 'cancelled' });
    if (when === 'during') {
      const signal = await entered.promise;
      controller.abort();
      expect(signal.aborted).toBe(true);
    }
    await rejected;
    expect(hook).toHaveBeenCalledTimes(when === 'before' ? 0 : 1);
    expect(diagnostics).toEqual([]);
    pending.resolve('allow');
  },
);

test('runtime wiring keeps checked text out of a failed snapshot and diagnostics', async () => {
  const diagnostics: DiagnosticEvent[] = [];
  const hook = vi.fn<OutputSafetyHook>(() => {
    throw new Error(sentinel);
  });
  const executor = new FakeExecutor([
    async function* (request) {
      const call = await request.models.begin('assistant');
      try {
        await call.checkOutput(sentinel, { final: true });
      } finally {
        call.fail();
      }
      yield { type: 'output', output: 'unreachable' };
    },
  ]);
  const runtime = createRuntime({
    appId: 'test',
    executors: [executor],
    outputSafety: hook,
    diagnostics: (event) => diagnostics.push(event),
  });
  const instance = await runtime.create(routed, { agent: {}, principalScope: 'user', models });
  await instance.prepare();
  const { runId } = await instance.start('input');
  for await (const _event of instance.events(runId)) {
  }
  expect(instance.getSnapshot().run).toMatchObject({
    status: 'failed',
    error: { code: 'executor_error' },
  });
  expect(hook).toHaveBeenCalledTimes(1);
  expect(diagnostics.find((event) => event.kind === 'output_safety_failed')).not.toHaveProperty(
    'error',
  );
  expect(JSON.stringify([instance.getSnapshot(), diagnostics])).not.toContain(sentinel);
  await runtime.dispose();
});
