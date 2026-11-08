// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { context, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  StackContextManager,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import {
  type CapabilityBinding,
  type CapabilityRequests,
  createRuntime,
  DEFAULT_DATA_POLICY,
  type ErrorCode,
  GalaxieError,
  galaxieField,
  httpCapability,
  type TraceHandle,
} from '../src/index.js';
import { startRunTrace } from '../src/tracing.js';
import { VERSION } from '../src/version.js';
import {
  binding,
  collect,
  deferred,
  definition,
  FakeExecutor,
  flush,
  type Script,
} from './fake-executor.js';
import { assertSpanTree, serializeSpans } from './span-tree.js';

afterEach(() => {
  trace.disable();
  context.disable();
});

async function recorded(script: Script): Promise<InMemorySpanExporter> {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  const executor = new FakeExecutor([script]);
  const runtime = createRuntime({
    appId: 'test-app',
    executors: [executor],
    tracerProvider: provider,
  });
  const instance = await runtime.create(definition, {
    principalScope: 'private-principal',
    agent: {},
  });
  await instance.prepare();
  const { runId } = await instance.start('canary-input');
  await collect(instance.events(runId));
  await runtime.dispose();
  await provider.forceFlush();
  return exporter;
}

test('records explicit run, node and model parents without a context manager', async () => {
  const exporter = await recorded(async function* ({ trace: recorder }) {
    const a = recorder.start({ kind: 'node', name: 'a', step: 1 });
    const model = recorder.start({ kind: 'model', provider: 'fixture', model: 'fixture-1' }, a);
    model.end({
      status: 'ok',
      usage: { inputTokens: 2, outputTokens: 3 },
      responseModel: 'fixture-1',
    });
    a.end({ status: 'ok' });
    recorder.start({ kind: 'node', name: 'b' }).end({ status: 'ok' });
    yield { type: 'output', output: 'done' };
  });
  const spans = exporter.getFinishedSpans();
  const tree = assertSpanTree(spans);
  expect(tree).toEqual({
    name: 'invoke_agent tests/agent',
    children: [
      { name: 'galaxie.node a', children: [{ name: 'chat fixture-1', children: [] }] },
      { name: 'galaxie.node b', children: [] },
    ],
  });
  expect(new Set(spans.map((span) => span.spanContext().traceId)).size).toBe(1);
  expect(
    spans.find((span) => span.name.startsWith('invoke_agent'))?.parentSpanContext,
  ).toBeUndefined();
  expect(spans.find((span) => span.name === 'chat fixture-1')?.attributes).toMatchObject({
    'gen_ai.provider.name': 'fixture',
    'gen_ai.usage.input_tokens': 2,
    'gen_ai.usage.output_tokens': 3,
  });
});

test('failure ends every open child and root with ERROR and no content', async () => {
  const exporter = await recorded(async function* ({ trace: recorder }) {
    const node = recorder.start({ kind: 'node', name: 'a' });
    yield { type: 'stream', executor: 'fake', path: [], mode: 'values', data: null };
    recorder
      .start({ kind: 'model', model: 'canary-model-x\n' }, node)
      .end({ status: 'error', errorType: 'TypeError' });
    throw new TypeError('secret-canary');
  });
  const spans = exporter.getFinishedSpans();
  assertSpanTree(spans);
  expect(spans).toHaveLength(3);
  for (const span of spans) expect(span.status).toEqual({ code: SpanStatusCode.ERROR });
  expect(spans.every((span) => span.attributes['error.type'] === 'TypeError')).toBe(true);
  const serialized = serializeSpans(spans);
  for (const secret of ['secret-canary', 'canary-input', 'canary-model-x', 'private-principal'])
    expect(serialized).not.toContain(secret);
  expect(spans.filter((span) => 'galaxie.error.code' in span.attributes)).toHaveLength(1);
});

test('cancellation ends open spans children first; late handle ends do nothing', async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  const latch = deferred<void>();
  let late: TraceHandle | undefined;
  const executor = new FakeExecutor([
    async function* ({ trace: recorder }) {
      const node = recorder.start({ kind: 'node', name: 'a' });
      late = recorder.start({ kind: 'model' }, node);
      await latch.promise;
      yield { type: 'output', output: 'late' };
    },
  ]);
  const runtime = createRuntime({
    appId: 'tests',
    executors: [executor],
    tracerProvider: provider,
  });
  const instance = await runtime.create(definition, { principalScope: 'user', agent: {} });
  await instance.prepare();
  const { runId } = await instance.start('input');
  await flush();
  await instance.cancel(runId);
  await provider.forceFlush();
  const before = serializeSpans(exporter.getFinishedSpans());
  late?.end({ status: 'error', errorType: 'ShouldNotAppear' });
  expect(serializeSpans(exporter.getFinishedSpans())).toBe(before);
  expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual([
    'chat',
    'galaxie.node a',
    'invoke_agent tests/agent',
  ]);
  for (const span of exporter.getFinishedSpans()) {
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    expect(
      span.attributes[
        span.name.startsWith('invoke_agent') ? 'galaxie.run.status' : 'galaxie.step.status'
      ],
    ).toBe('cancelled');
  }
  latch.resolve();
  await runtime.dispose();
});

test('sanitizes executor names and drops nonprimitive attributes', async () => {
  const exporter = await recorded(async function* ({ trace: recorder }) {
    recorder.start({ kind: 'node', name: 'x'.repeat(200), step: Number.NaN }).end({ status: 'ok' });
    recorder.start({ kind: 'node', name: 'bad\nname' }).end({ status: 'ok' });
    recorder
      .start({ kind: 'model', provider: {} as string })
      .end({ status: 'ok', usage: { inputTokens: Number.POSITIVE_INFINITY } });
    yield { type: 'output', output: null };
  });
  const spans = exporter.getFinishedSpans();
  assertSpanTree(spans);
  expect(spans.filter((span) => span.name === 'galaxie.node _OTHER')).toHaveLength(2);
  expect(
    spans.find((span) => span.name === 'chat')?.attributes['gen_ai.provider.name'],
  ).toBeUndefined();
});

test('captures the host parent synchronously at start, before validation awaits', async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  const manager = new StackContextManager().enable();
  context.setGlobalContextManager(manager);
  const host = provider.getTracer('host').startSpan('host');
  const executor = new FakeExecutor();
  const runtime = createRuntime({
    appId: 'tests',
    executors: [executor],
    tracerProvider: provider,
  });
  const instance = await runtime.create(definition, { principalScope: 'user', agent: {} });
  await instance.prepare();
  const accepted = context.with(trace.setSpan(context.active(), host), () =>
    instance.start('input'),
  );
  const { runId } = await accepted;
  await collect(instance.events(runId));
  await runtime.dispose();
  host.end();
  await provider.forceFlush();
  expect(
    exporter.getFinishedSpans().find((span) => span.name.startsWith('invoke_agent'))
      ?.parentSpanContext?.spanId,
  ).toBe(host.spanContext().spanId);
  manager.disable();
});

test('uses the global provider when none is injected', async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  trace.setGlobalTracerProvider(provider);
  const runtime = createRuntime({ appId: 'tests', executors: [new FakeExecutor()] });
  const instance = await runtime.create(definition, { principalScope: 'user', agent: {} });
  await instance.prepare();
  const { runId } = await instance.start('input');
  await collect(instance.events(runId));
  await runtime.dispose();
  await provider.forceFlush();
  expect(exporter.getFinishedSpans()).toHaveLength(1);
});

async function recordedCapabilities(
  script: Script,
  bindings: Readonly<Record<string, CapabilityBinding>>,
  requests: CapabilityRequests = {
    'lessons.get@1': {
      input: z.string(),
      output: z.string().meta(galaxieField({ label: 'public' })),
      kind: 'read',
    },
    'progress.save@1': { input: z.string(), output: z.string(), kind: 'write' },
  },
): Promise<{ exporter: InMemorySpanExporter; fields: string }> {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  const errors: unknown[] = [];
  const executor = new FakeExecutor([
    typeof script !== 'function'
      ? script
      : async function* (request) {
          try {
            yield* script(request);
          } catch (error) {
            errors.push(error);
            throw error;
          }
        },
  ]);
  const runtime = createRuntime({
    appId: 'span-tests',
    executors: [executor],
    tracerProvider: provider,
  });
  const instance = await runtime.create(
    {
      ...definition,
      input: z.string().meta(galaxieField({ label: 'private-user' })),
      capabilities: { optional: requests },
    },
    { principalScope: 'user', agent: {}, bindings },
  );
  await instance.prepare();
  const run = await instance.start('canary-private-run-value');
  const events = await collect(instance.events(run.runId));
  await runtime.dispose();
  await provider.forceFlush();
  expect(errors).toEqual([]);
  return { exporter, fields: JSON.stringify([events, instance.getSnapshot()]) };
}

test('capability spans follow explicit node parents and otherwise the root, with sticky root labels', async () => {
  const { exporter } = await recordedCapabilities(
    async function* ({ trace: recorder, capabilities }) {
      const node = recorder.start({ kind: 'node', name: 'lookup' });
      await capabilities.call('lessons.get@1', 'query', { parent: node });
      node.end({ status: 'ok' });
      await capabilities.call('lessons.get@1', 'query');
      yield { type: 'output', output: null };
    },
    { 'lessons.get@1': binding() },
  );
  const spans = exporter.getFinishedSpans();
  expect(assertSpanTree(spans)).toEqual({
    name: 'invoke_agent tests/agent',
    children: [
      { name: 'execute_tool lessons.get@1', children: [] },
      {
        name: 'galaxie.node lookup',
        children: [{ name: 'execute_tool lessons.get@1', children: [] }],
      },
    ],
  });
  const root = spans.find((span) => span.name.startsWith('invoke_agent'));
  expect(root?.attributes['galaxie.run.labels']).toEqual(['private-user', 'public']);
  for (const span of spans.filter((span) => span.name.startsWith('execute_tool'))) {
    expect(span.kind).toBe(SpanKind.INTERNAL);
    expect(span.attributes).toMatchObject({
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'lessons.get@1',
      'galaxie.capability.kind': 'read',
      'galaxie.destination.class': 'in-browser',
      'galaxie.step.status': 'ok',
    });
  }
});
test('AE1 spans requested unbound denials but omits unrequested caller text', async () => {
  const { exporter } = await recordedCapabilities(
    async function* ({ capabilities }) {
      await expect(capabilities.call('progress.save@1', 'argument')).rejects.toMatchObject({
        code: 'denied',
      });
      await expect(capabilities.call('canary-unrequested-name', 'argument')).rejects.toMatchObject({
        code: 'denied',
      });
      yield { type: 'output', output: null };
    },
    { 'lessons.get@1': binding() },
  );
  const spans = exporter.getFinishedSpans();
  assertSpanTree(spans);
  const unbound = spans.find((span) => span.name === 'execute_tool progress.save@1');
  expect(unbound?.attributes['galaxie.error.code']).toBe('denied');
  expect(unbound?.attributes['galaxie.capability.kind']).toBeUndefined();
  const unknown = spans.find((span) => span.name === 'execute_tool');
  expect(unknown?.attributes['gen_ai.tool.name']).toBeUndefined();
  expect(serializeSpans(spans)).not.toContain('canary-unrequested-name');
});
const codes: ErrorCode[] = [
  'invalid',
  'denied',
  'unavailable',
  'unreachable',
  'unsupported',
  'budget_exceeded',
  'timeout',
  'stale',
  'duplicate',
  'fenced',
  'cancelled',
  'unrecoverable',
  'outcome_unknown',
  'render_failed',
  'executor_error',
];
test.each(codes)('capability %s errors use fixed span types and statuses', (code) => {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  const instrumentation = startRunTrace(
    provider.getTracer('@galaxie-ai/core', VERSION),
    ROOT_CONTEXT,
    {
      appId: 'test',
      agentId: 'test',
      agentVersion: '1',
      instanceId: 'i',
      sessionId: 's',
      runId: 'r',
      executorId: 'fake',
      executorVersion: '1',
    },
  );
  instrumentation
    .startCapability({ name: 'echo@1', kind: 'read', destination: 'in-browser' })
    .end(code === 'cancelled' ? { status: 'cancelled' } : { status: 'error', code });
  instrumentation.setLabels(['app']);
  instrumentation.recordBudget('toolCalls');
  instrumentation.finish('succeeded');
  const spans = exporter.getFinishedSpans();
  assertSpanTree(spans);
  const span = spans.find((span) => span.name === 'execute_tool echo@1');
  if (code === 'cancelled') {
    expect(span?.status.code).toBe(SpanStatusCode.UNSET);
    expect(span?.attributes['galaxie.step.status']).toBe('cancelled');
  } else {
    expect(span?.status).toEqual({ code: SpanStatusCode.ERROR });
    expect(span?.attributes).toMatchObject({
      'error.type': 'GalaxieError',
      'galaxie.error.code': code,
    });
  }
  expect(
    spans.find((span) => span.name.startsWith('invoke_agent'))?.attributes['galaxie.budget.name'],
  ).toBe('toolCalls');
});
test('HTTP credentials, input/output and binding-error canaries never enter generated fields or spans', async () => {
  const errors: unknown[] = [];
  const { exporter, fields } = await recordedCapabilities(
    async function* ({ capabilities }) {
      await capabilities.call('http@1', { id: 'entry' });
      try {
        await capabilities.call('fail@1', 'query');
      } catch (error) {
        errors.push(error);
      }
      yield { type: 'output', output: null };
    },
    {
      'http@1': httpCapability({
        ...binding(),
        destination: 'host-server',
        url: 'https://api.example.test/private/{id}',
        method: 'GET',
        headers: () => ({ authorization: 'canary-credential-7f3a' }),
        fetch: async () => Response.json('canary-capability-result'),
      }),
      'fail@1': binding({
        invoke: async () => {
          throw new Error('canary-binding-message');
        },
      }),
    },
    {
      'http@1': {
        input: z.object({ id: z.enum(['entry']) }),
        output: z.string().meta(galaxieField({ label: 'private-user' })),
        kind: 'read',
      },
      'fail@1': { input: z.string(), output: z.string(), kind: 'read' },
    },
  );
  expect(errors[0]).toBeInstanceOf(GalaxieError);
  expect(errors[0]).not.toHaveProperty('cause');
  const spans = exporter.getFinishedSpans();
  assertSpanTree(spans);
  const generated = fields + serializeSpans(spans) + JSON.stringify(errors);
  for (const canary of [
    'canary-credential-7f3a',
    'canary-private-run-value',
    'canary-capability-result',
    'canary-binding-message',
    'https://api.example.test',
  ])
    expect(generated).not.toContain(canary);
});
test('run finish ends an open capability span without accepting a later end', () => {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  const instrumentation = startRunTrace(
    provider.getTracer('@galaxie-ai/core', VERSION),
    ROOT_CONTEXT,
    {
      appId: 'test',
      agentId: 'test',
      agentVersion: '1',
      instanceId: 'i',
      sessionId: 's',
      runId: 'r',
      executorId: 'fake',
      executorVersion: '1',
    },
  );
  const open = instrumentation.startCapability({ name: 'echo@1' });
  instrumentation.finish('succeeded');
  const before = serializeSpans(exporter.getFinishedSpans());
  open.end({ status: 'error', code: 'unavailable' });
  expect(serializeSpans(exporter.getFinishedSpans())).toBe(before);
  assertSpanTree(exporter.getFinishedSpans());
});

test.each(['ok', 'error'] as const)(
  'model %s results record filtered route attributes only when supplied',
  async (status) => {
    const exporter = await recorded(async function* ({ trace: recorder }) {
      recorder
        .start({ kind: 'model', model: 'routed' })
        .end({ status, route: { providerId: 'local', destination: 'in-browser' } });
      recorder
        .start({ kind: 'model', model: 'unsafe' })
        .end({ status, route: { providerId: 'unsafe\nprovider', destination: 'host-server' } });
      recorder.start({ kind: 'model', model: 'plain' }).end({ status });
      yield { type: 'output', output: null };
    });
    const spans = exporter.getFinishedSpans();
    expect(spans.find((span) => span.name === 'chat routed')?.attributes).toMatchObject({
      'galaxie.model.provider': 'local',
      'galaxie.destination.class': 'in-browser',
    });
    expect(spans.find((span) => span.name === 'chat unsafe')?.attributes).toMatchObject({
      'galaxie.model.provider': '_OTHER',
      'galaxie.destination.class': 'host-server',
    });
    const plain = spans.find((span) => span.name === 'chat plain');
    expect(plain?.attributes).not.toHaveProperty('galaxie.model.provider');
    expect(plain?.attributes).not.toHaveProperty('galaxie.destination.class');
  },
);

test('a route known at model start survives the run closing before the model callback', async () => {
  const exporter = await recorded(async function* ({ trace: recorder }) {
    recorder.start({
      kind: 'model',
      model: 'closing',
      route: { providerId: 'local', destination: 'in-browser' },
    });
    yield { type: 'stream', executor: 'fake', path: [], mode: 'values', data: null };
    throw new Error('private');
  });
  expect(
    exporter.getFinishedSpans().find((span) => span.name === 'chat closing')?.attributes,
  ).toMatchObject({ 'galaxie.model.provider': 'local', 'galaxie.destination.class': 'in-browser' });
});

test('a paused segment ends with its own status and no error', async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  const executor = new FakeExecutor([
    [
      {
        type: 'interaction',
        interaction: {
          interactionId: 'ask' as import('../src/index.js').InteractionId,
          surfaceId: 'main',
          viewRevision: 'r1' as import('../src/index.js').ViewRevision,
          component: 'tests.Question/v1',
          props: {},
        },
      },
    ],
  ]);
  const runtime = createRuntime({
    appId: 'tests',
    executors: [executor],
    tracerProvider: provider,
  });
  const instance = await runtime.create(definition, { principalScope: 'user', agent: {} });
  await instance.prepare();
  await instance.start('input');
  await flush();
  const root = exporter.getFinishedSpans().find((span) => span.name.startsWith('invoke_agent'));
  expect(root?.attributes).toMatchObject({
    'galaxie.run.status': 'waiting_input',
    'galaxie.run.segment': 0,
  });
  expect(root?.status.code).toBe(SpanStatusCode.UNSET);
  await runtime.dispose();
  expect(executor.requests).toHaveLength(1);
  expect(executor.disposeCalls).toBe(1);
  await provider.shutdown();
});

test('development trace text validates its declared destination', () => {
  for (const developmentTraceText of [{ destination: 'unknown' }, {}, null])
    expect(() =>
      createRuntime({
        appId: 'trace-text',
        executors: [new FakeExecutor()],
        developmentTraceText: developmentTraceText as never,
      }),
    ).toThrowError(expect.objectContaining({ code: 'invalid' }));
});

test('trace text omits non-serializable input without throwing and defaults to no recording', () => {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  const metadata = {
    appId: 'test',
    agentId: 'test',
    agentVersion: '1',
    instanceId: 'i',
    sessionId: 's',
    runId: 'r',
    executorId: 'fake',
    executorVersion: '1',
  };
  const absent = startRunTrace(
    provider.getTracer('@galaxie-ai/core', VERSION),
    ROOT_CONTEXT,
    metadata,
    { policy: DEFAULT_DATA_POLICY, labels: () => new Set(['public']) },
  );
  expect(absent.recorder.recordsText).toBe(false);
  absent.recorder
    .start({ kind: 'model', input: [{ secret: 'without opt-in' }] })
    .end({ status: 'ok', output: [{ secret: 'without opt-in' }] });
  const absentCapability = absent.startCapability({ name: 'echo@1' });
  absentCapability.arguments({ secret: 'without opt-in' });
  absentCapability.end({ status: 'ok' });
  absent.finish('succeeded');
  const enabled = startRunTrace(
    provider.getTracer('@galaxie-ai/core', VERSION),
    ROOT_CONTEXT,
    metadata,
    {
      developmentTraceText: { destination: 'third-party' },
      policy: DEFAULT_DATA_POLICY,
      labels: () => new Set(['public']),
    },
  );
  expect(enabled.recorder.recordsText).toBe(true);
  const input: Record<string, unknown> = {};
  input['self'] = input;
  expect(() => {
    enabled.recorder.start({ kind: 'model', input }).end({ status: 'ok', output: input });
    enabled.startCapability({ name: 'echo@1' }).arguments(input);
    enabled.finish('succeeded');
  }).not.toThrow();
  expect(serializeSpans(exporter.getFinishedSpans())).not.toMatch(
    /gen_ai\.(input.messages|output.messages|tool.call.arguments)|without opt-in/,
  );
});
