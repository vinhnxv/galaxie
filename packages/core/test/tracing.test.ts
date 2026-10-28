// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  StackContextManager,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import { afterEach, expect, test } from 'vitest';
import { createRuntime, type TraceHandle } from '../src/index.js';
import {
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
