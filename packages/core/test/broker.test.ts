// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import {
  type CapabilityContext,
  createRuntime,
  type ErrorCode,
  GalaxieError,
  galaxieField,
  type RunRequest,
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

afterEach(() => vi.useRealTimers());
const request = { input: z.string(), output: z.string(), kind: 'read' as const };

test('AE1 denies requested unbound and unrequested calls without host execution', async () => {
  const invoke = vi.fn(async (input: unknown) => input);
  const fixture = await brokerFixture({
    requests: { 'lessons.get@1': request, 'progress.save@1': request },
    bindings: { 'lessons.get@1': binding({ invoke }) },
    scripts: [
      async function* ({ capabilities }) {
        await expect(capabilities.call('progress.save@1', 'text')).rejects.toMatchObject({
          code: 'denied',
        });
        await expect(capabilities.call('__proto__', 'text')).rejects.toMatchObject({
          code: 'denied',
        });
        await expect(capabilities.call('lessons.get@1', 'text')).resolves.toBe('text');
        yield { type: 'output', output: null };
      },
    ],
  });
  const { runId } = await fixture.instance.start('input');
  await collect(fixture.instance.events(runId));
  expect(invoke).toHaveBeenCalledTimes(1);
  await fixture.runtime.dispose();
  expect(fixture.scriptErrors).toEqual([]);
});
test('create rejects missing required and unrequested bindings', async () => {
  const runtime = createRuntime({ appId: 'test', executors: [new FakeExecutor()] });
  const required = { ...definition, capabilities: { required: { 'echo@1': request } } };
  await expect(
    // @ts-expect-error -- runtime repeats the required-binding type check.
    runtime.create(required, { principalScope: 'user', agent: {} }),
  ).rejects.toMatchObject({ code: 'invalid' });
  await expect(
    runtime.create(definition, {
      principalScope: 'user',
      agent: {},
      bindings: { 'echo@1': binding() },
    }),
  ).rejects.toMatchObject({ code: 'invalid' });
  await runtime.dispose();
});
test.each([
  { timeoutMs: 0 },
  { timeoutMs: Number.NaN },
  { timeoutMs: Infinity },
  { concurrency: 0 },
  { concurrency: 1.5 },
  { kind: 'bad' },
  { destination: 'bad' },
  { grantScope: 'bad' },
  { approval: 'bad' },
  { retry: 'bad' },
])('rejects invalid binding fields: %j', async (invalid) => {
  await expect(
    brokerFixture({ bindings: { 'echo@1': binding(invalid as never) } }),
  ).rejects.toMatchObject({ code: 'invalid' });
});
test('run grants apply only to a bound run-scoped capability', async () => {
  const fixture = await brokerFixture({
    bindings: { 'echo@1': binding({ grantScope: 'run' }) },
    scripts: [
      async function* ({ capabilities }) {
        await expect(capabilities.call('echo@1', 'x')).rejects.toMatchObject({ code: 'denied' });
        yield { type: 'output', output: null };
      },
      async function* ({ capabilities }) {
        await expect(capabilities.call('echo@1', 'x')).resolves.toBe('x');
        yield { type: 'output', output: null };
      },
    ],
  });
  await expect(fixture.instance.start('input', { grants: ['missing@1'] })).rejects.toMatchObject({
    code: 'invalid',
  });
  let run = await fixture.instance.start('input');
  await collect(fixture.instance.events(run.runId));
  run = await fixture.instance.start('input', { grants: ['echo@1'] });
  await collect(fixture.instance.events(run.runId));
  await fixture.runtime.dispose();
  expect(fixture.scriptErrors).toEqual([]);
  const other = await brokerFixture();
  await expect(other.instance.start('input', { grants: ['echo@1'] })).rejects.toMatchObject({
    code: 'invalid',
  });
  await other.runtime.dispose();
});
test('confirmation refuses dispatch and invalid input never invokes', async () => {
  const invoke = vi.fn(async () => 'ok');
  const fixture = await brokerFixture({
    requests: { 'confirm@1': request, 'echo@1': request },
    bindings: {
      'confirm@1': binding({ approval: 'confirm', invoke }),
      'echo@1': binding({ invoke }),
    },
    scripts: [
      async function* ({ capabilities }) {
        await expect(capabilities.call('confirm@1', 'x')).rejects.toMatchObject({
          code: 'unsupported',
        });
        await expect(capabilities.call('echo@1', 2)).rejects.toMatchObject({ code: 'invalid' });
        yield { type: 'output', output: null };
      },
    ],
  });
  const { runId } = await fixture.instance.start('input');
  await collect(fixture.instance.events(runId));
  expect(invoke).not.toHaveBeenCalled();
  await fixture.runtime.dispose();
  expect(fixture.scriptErrors).toEqual([]);
});
test('invalid outputs are neither returned nor labelled', async () => {
  const fixture = await brokerFixture({
    requests: {
      'echo@1': { ...request, output: z.string().meta(galaxieField({ label: 'private-user' })) },
    },
    bindings: { 'echo@1': binding({ invoke: async () => 3 }) },
    scripts: [
      async function* ({ capabilities }) {
        await expect(capabilities.call('echo@1', 'x')).rejects.toMatchObject({ code: 'invalid' });
        yield { type: 'output', output: null };
      },
    ],
  });
  const { runId } = await fixture.instance.start('input');
  await collect(fixture.instance.events(runId));
  expect(fixture.instance.getSnapshot().run?.labels).toEqual(['app']);
  await fixture.runtime.dispose();
  expect(fixture.scriptErrors).toEqual([]);
});
test('AE5 timeout drops late results without validation or labels', async () => {
  vi.useFakeTimers();
  const gate = deferred<unknown>();
  const validate = vi.fn(() => true);
  const fixture = await brokerFixture({
    requests: {
      'echo@1': {
        ...request,
        output: z
          .string()
          .refine(validate)
          .meta(galaxieField({ label: 'private-user' })),
      },
    },
    bindings: { 'echo@1': binding({ timeoutMs: 10, invoke: () => gate.promise }) },
    scripts: [
      async function* ({ capabilities }) {
        await expect(capabilities.call('echo@1', 'x')).rejects.toMatchObject({ code: 'timeout' });
        yield { type: 'output', output: null };
      },
    ],
  });
  const { runId } = await fixture.instance.start('input');
  await vi.advanceTimersByTimeAsync(10);
  await collect(fixture.instance.events(runId));
  gate.resolve('private late canary');
  await flush();
  expect(validate).not.toHaveBeenCalled();
  expect(fixture.instance.getSnapshot().run?.labels).toEqual(['app']);
  expect(fixture.diagnostics).toContainEqual(
    expect.objectContaining({ kind: 'late_result', runId }),
  );
  expect(JSON.stringify(fixture.diagnostics)).not.toContain('private late canary');
  await fixture.runtime.dispose();
  expect(fixture.scriptErrors).toEqual([]);
});
test.each(['run', 'caller'] as const)(
  '%s cancellation aborts the binding and rejects cancelled',
  async (mode) => {
    const gate = deferred<unknown>();
    const caller = new AbortController();
    let signal: AbortSignal | undefined;
    const fixture = await brokerFixture({
      bindings: {
        'echo@1': binding({
          invoke: (_input, context) => {
            signal = context.signal;
            return gate.promise;
          },
        }),
      },
      scripts: [
        async function* ({ capabilities }) {
          await expect(
            capabilities.call('echo@1', 'x', { signal: caller.signal }),
          ).rejects.toMatchObject({ code: 'cancelled' });
          yield { type: 'output', output: null };
        },
      ],
    });
    const { runId } = await fixture.instance.start('input');
    await flush();
    if (mode === 'run') await fixture.instance.cancel(runId);
    else caller.abort();
    await flush();
    expect(signal?.aborted).toBe(true);
    gate.resolve('late');
    await fixture.runtime.dispose();
    expect(fixture.scriptErrors).toEqual([]);
  },
);
test('concurrency is FIFO and timeout keeps a slot until host settlement', async () => {
  vi.useFakeTimers();
  const first = deferred<unknown>();
  const entered: unknown[] = [];
  const fixture = await brokerFixture({
    bindings: {
      'echo@1': binding({
        timeoutMs: 10,
        invoke: (input) => {
          entered.push(input);
          return entered.length === 1 ? first.promise : Promise.resolve(input);
        },
      }),
    },
    scripts: [
      async function* ({ capabilities }) {
        const a = capabilities.call('echo@1', 'first').catch((error) => error.code);
        await flush();
        const b = capabilities.call('echo@1', 'second').catch((error) => error.code);
        await vi.advanceTimersByTimeAsync(10);
        expect(await a).toBe('timeout');
        expect(await b).toBe('timeout');
        expect(entered).toEqual(['first']);
        const c = capabilities.call('echo@1', 'third');
        const d = capabilities.call('echo@1', 'fourth');
        await flush();
        expect(entered).toEqual(['first']);
        first.resolve('late');
        expect(await c).toBe('third');
        expect(await d).toBe('fourth');
        expect(entered).toEqual(['first', 'third', 'fourth']);
        yield { type: 'output', output: null };
      },
    ],
  });
  const { runId } = await fixture.instance.start('input');
  await collect(fixture.instance.events(runId));
  await fixture.runtime.dispose();
  expect(fixture.scriptErrors).toEqual([]);
});
test('bindings get fresh effect IDs, no retry, and content-free errors', async () => {
  const contexts: CapabilityContext[] = [];
  const raw = new Error('canary-binding-message');
  let graphError: unknown;
  const fixture = await brokerFixture({
    bindings: {
      'echo@1': binding({
        retry: 'idempotent',
        invoke: async (_input, context) => {
          contexts.push(context);
          throw raw;
        },
      }),
    },
    scripts: [
      async function* ({ capabilities }) {
        for (let i = 0; i < 2; i++)
          try {
            await capabilities.call('echo@1', 'x');
          } catch (error) {
            graphError = error;
            expect(error).toMatchObject({
              code: 'unavailable',
              message: 'The requested service is unavailable.',
            });
            expect(error).not.toHaveProperty('cause');
          }
        yield { type: 'output', output: null };
      },
    ],
  });
  const { runId } = await fixture.instance.start('input');
  const events = await collect(fixture.instance.events(runId));
  expect(contexts).toHaveLength(2);
  expect(new Set(contexts.map((context) => context.effectId)).size).toBe(2);
  expect(contexts[0]?.agent.hash).toBe('');
  expect(JSON.stringify([events, fixture.instance.getSnapshot(), graphError])).not.toContain(
    'canary-binding-message',
  );
  expect(fixture.diagnostics).toContainEqual(
    expect.objectContaining({ kind: 'capability_failed', runId, error: raw }),
  );
  await fixture.runtime.dispose();
  expect(fixture.scriptErrors).toEqual([]);
});
test('known binding errors retain only the code and calls after terminal do not mutate', async () => {
  let saved: RunRequest | undefined;
  const fixture = await brokerFixture({
    bindings: {
      'echo@1': binding({
        invoke: async () => {
          throw new GalaxieError('denied', 'canary');
        },
      }),
    },
    scripts: [
      async function* (request) {
        saved = request;
        await expect(request.capabilities.call('echo@1', 'x')).rejects.toMatchObject({
          code: 'denied' as ErrorCode,
        });
        yield { type: 'output', output: null };
      },
    ],
  });
  const { runId } = await fixture.instance.start('input');
  await collect(fixture.instance.events(runId));
  const before = fixture.instance.getSnapshot();
  await expect(saved?.capabilities.call('echo@1', 'x')).rejects.toMatchObject({
    code: 'cancelled',
  });
  expect(fixture.instance.getSnapshot()).toBe(before);
  await fixture.runtime.dispose();
  expect(fixture.scriptErrors).toEqual([]);
});

test.each(['app', 'principal', 'instance'] as const)(
  '%s bindings are instance-lifetime grants',
  async (grantScope) => {
    const fixture = await brokerFixture({
      bindings: { 'echo@1': binding({ grantScope }) },
      scripts: [
        async function* ({ capabilities }) {
          await expect(capabilities.call('echo@1', 'x')).resolves.toBe('x');
          yield { type: 'output', output: null };
        },
      ],
    });
    const { runId } = await fixture.instance.start('input');
    await collect(fixture.instance.events(runId));
    await fixture.runtime.dispose();
    expect(fixture.scriptErrors).toEqual([]);
  },
);
test('run failure aborts in-flight capability signals without returning late output', async () => {
  const gate = deferred<unknown>();
  let signal: AbortSignal | undefined;
  const fixture = await brokerFixture({
    bindings: {
      'echo@1': binding({
        invoke: (_input, context) => {
          signal = context.signal;
          return gate.promise;
        },
      }),
    },
    scripts: [
      async function* ({ capabilities }) {
        const rejected = expect(capabilities.call('echo@1', 'x')).rejects.toMatchObject({
          code: 'cancelled',
        });
        await flush();
        yield { type: 'error', error: { code: 'unavailable', message: 'fixed' } };
        await rejected;
      },
    ],
  });
  const { runId } = await fixture.instance.start('input');
  await collect(fixture.instance.events(runId));
  await flush();
  expect(signal?.aborted).toBe(true);
  gate.resolve('late canary');
  await fixture.runtime.dispose();
  expect(fixture.scriptErrors).toEqual([]);
  expect(fixture.instance.getSnapshot().run?.error?.code).toBe('unavailable');
});
test('finite long timeouts are not truncated to one millisecond', async () => {
  vi.useFakeTimers();
  const gate = deferred<unknown>();
  const fixture = await brokerFixture({
    budgets: { wallClockMs: 4294967296 },
    bindings: { 'echo@1': binding({ timeoutMs: 4294967296, invoke: () => gate.promise }) },
    scripts: [
      async function* ({ capabilities }) {
        await expect(capabilities.call('echo@1', 'x')).resolves.toBe('ok');
        yield { type: 'output', output: null };
      },
    ],
  });
  const { runId } = await fixture.instance.start('input');
  await vi.advanceTimersByTimeAsync(2);
  expect(fixture.instance.getSnapshot().run?.status).toBe('running');
  gate.resolve('ok');
  await collect(fixture.instance.events(runId));
  await fixture.runtime.dispose();
  expect(fixture.scriptErrors).toEqual([]);
});
