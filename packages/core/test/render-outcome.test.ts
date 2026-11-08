// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { ROOT_CONTEXT } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import { expect, test } from 'vitest';
import {
  createRuntime,
  type InteractionId,
  type PendingInteraction,
  type RenderOutcome,
  type RunEvent,
  type RunId,
  type ViewRevision,
} from '../src/index.js';
import { startRunTrace } from '../src/tracing.js';
import { VERSION } from '../src/version.js';
import { collect, deferred, definition, FakeExecutor, flush } from './fake-executor.js';
import { assertSpanTree, createSpanRecorder, serializeSpans } from './span-tree.js';

const interaction: PendingInteraction = {
  interactionId: 'ask' as InteractionId,
  surfaceId: 'main',
  viewRevision: 'r2' as ViewRevision,
  component: 'tests.Question/v1',
  props: { title: 'private-render-props-canary' },
};

async function fixture() {
  const gate = deferred<void>();
  const resumeGate = deferred<void>();
  const recorder = createSpanRecorder();
  const executor = new FakeExecutor([
    [{ type: 'interaction', interaction }, { wait: gate.promise }],
    [{ wait: resumeGate.promise }, { type: 'output', output: null }],
  ]);
  Object.assign(executor.features, { resume: true });
  executor.agent.pending = async () => interaction;
  const runtime = createRuntime({
    appId: 'render-tests',
    executors: [executor],
    tracerProvider: recorder.provider,
  });
  const instance = await runtime.create(definition, { principalScope: 'user', agent: {} });
  await instance.prepare();
  const start = async (): Promise<RunId> => {
    const { runId } = await instance.start('input');
    await flush();
    return runId;
  };
  const settle = async (): Promise<void> => {
    gate.resolve();
    await flush();
    await recorder.provider.forceFlush();
  };
  return { ...recorder, runtime, instance, start, settle, resumeGate };
}

function outcome(runId: RunId): RenderOutcome {
  return {
    runId,
    interactionId: interaction.interactionId,
    viewRevision: interaction.viewRevision,
    status: 'rendered',
  };
}

function renderEvents(events: readonly RunEvent[]) {
  return events.filter((event) => event.type === 'render');
}

/** The render attributes of every render span, in end order. */
function renderSpans(spans: readonly ReadableSpan[]): Record<string, unknown>[] {
  return spans.filter((span) => span.name === 'galaxie.render').map((span) => span.attributes);
}

test('rendered is journaled once, delivered live without ending iteration and traced without content', async () => {
  const f = await fixture();
  try {
    const runId = await f.start();
    const iterator = f.instance.events(runId)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'interaction' } });
    const next = iterator.next();
    const snapshot = f.instance.getSnapshot();
    const withContent = {
      ...outcome(runId),
      props: interaction.props,
      modelText: 'private-render-props-canary',
      userText: 'private-render-props-canary',
    };
    f.instance.recordRenderOutcome(withContent);
    f.instance.recordRenderOutcome(outcome(runId));
    const live = await next;
    expect(live.done).toBe(false);
    expect(live.value).toEqual({
      ...outcome(runId),
      type: 'render',
      eventId: expect.any(String),
      sequence: 1,
    });
    expect(Object.isFrozen(live.value)).toBe(true);
    expect(f.instance.getSnapshot()).toBe(snapshot);
    let ended = false;
    const following = iterator.next().then((event) => {
      ended = event.done === true;
      return event;
    });
    await flush();
    expect(ended).toBe(false);
    await f.settle();
    const spans = f.exporter.getFinishedSpans();
    assertSpanTree(spans);
    expect(renderSpans(spans)).toEqual([{ 'galaxie.render.status': 'rendered' }]);
    expect(JSON.stringify(live.value) + serializeSpans(spans)).not.toContain(
      'private-render-props-canary',
    );
    await f.instance.cancel(runId);
    await expect(following).resolves.toMatchObject({ value: { type: 'cancelled' } });
    const replay = renderEvents(await collect(f.instance.events(runId)));
    expect(replay).toEqual([live.value]);
    await iterator.return?.();
  } finally {
    f.resumeGate.resolve();
    await f.settle();
    await f.runtime.dispose();
  }
});

test('rendered then failed is recorded, failures keep waiting and all later reports are ignored', async () => {
  const f = await fixture();
  try {
    const runId = await f.start();
    const rendered = outcome(runId);
    const failed: RenderOutcome = { ...rendered, status: 'failed', code: 'render_failed' };
    f.instance.recordRenderOutcome(rendered);
    f.instance.recordRenderOutcome(failed);
    f.instance.recordRenderOutcome(failed);
    f.instance.recordRenderOutcome({ ...failed, code: 'denied' });
    f.instance.recordRenderOutcome(rendered);
    expect(f.instance.getSnapshot().run?.status).toBe('waiting_input');
    await f.settle();
    const spans = f.exporter.getFinishedSpans();
    assertSpanTree(spans);
    expect(renderSpans(spans)).toEqual([
      { 'galaxie.render.status': 'rendered' },
      { 'galaxie.render.status': 'failed', 'galaxie.render.error.code': 'render_failed' },
    ]);
    await f.instance.cancel(runId);
    const events = renderEvents(await collect(f.instance.events(runId)));
    expect(events.map(({ status, code }) => ({ status, code }))).toEqual([
      { status: 'rendered', code: undefined },
      { status: 'failed', code: 'render_failed' },
    ]);
    expect(Object.keys(events[1] ?? {}).sort()).toEqual([
      'code',
      'eventId',
      'interactionId',
      'runId',
      'sequence',
      'status',
      'type',
      'viewRevision',
    ]);
    expect(JSON.stringify(events) + serializeSpans(spans)).not.toContain(
      'private-render-props-canary',
    );
  } finally {
    f.resumeGate.resolve();
    await f.settle();
    await f.runtime.dispose();
  }
});

test.each([
  { viewRevision: 'r1' as ViewRevision },
  { interactionId: 'unknown' as InteractionId },
  { runId: 'another-run' as RunId },
])('mismatched render identity is ignored: %j', async (override) => {
  const f = await fixture();
  try {
    const runId = await f.start();
    expect(() => f.instance.recordRenderOutcome({ ...outcome(runId), ...override })).not.toThrow();
    await f.settle();
    expect(renderSpans(f.exporter.getFinishedSpans())).toEqual([]);
    await f.instance.cancel(runId);
    expect(renderEvents(await collect(f.instance.events(runId)))).toEqual([]);
  } finally {
    f.resumeGate.resolve();
    await f.settle();
    await f.runtime.dispose();
  }
});

test('reports before a run and after leaving waiting_input or disposal never throw or record', async () => {
  const f = await fixture();
  try {
    expect(() => f.instance.recordRenderOutcome(outcome('missing' as RunId))).not.toThrow();
    const runId = await f.start();
    await f.settle();
    const receipt = await f.instance.dispatch({
      instanceId: f.instance.instanceId,
      runId,
      interactionId: interaction.interactionId,
      surfaceId: interaction.surfaceId,
      viewRevision: interaction.viewRevision,
      action: 'submit',
      payload: null,
    });
    expect(receipt.status).toBe('accepted');
    expect(f.instance.getSnapshot().run?.status).toBe('running');
    expect(() => f.instance.recordRenderOutcome(outcome(runId))).not.toThrow();
    f.resumeGate.resolve();
    await flush();
    expect(f.instance.getSnapshot().run?.status).toBe('succeeded');
    expect(() => f.instance.recordRenderOutcome(outcome(runId))).not.toThrow();
    const events = await collect(f.instance.events(runId));
    await f.instance.dispose();
    expect(() => f.instance.recordRenderOutcome(outcome(runId))).not.toThrow();
    expect(renderEvents(events)).toEqual([]);
    expect(renderSpans(f.exporter.getFinishedSpans())).toEqual([]);
  } finally {
    f.resumeGate.resolve();
    await f.settle();
    await f.runtime.dispose();
  }
});

test('an outcome recorded after the paused segment closed reaches the journal and the trace', async () => {
  const f = await fixture();
  try {
    const runId = await f.start();
    await f.settle();
    f.instance.recordRenderOutcome({ ...outcome(runId), status: 'failed', code: 'unsupported' });
    expect(f.instance.getSnapshot().run?.status).toBe('waiting_input');
    const spans = f.exporter.getFinishedSpans();
    assertSpanTree(spans);
    expect(renderSpans(spans)).toEqual([
      { 'galaxie.render.status': 'failed', 'galaxie.render.error.code': 'unsupported' },
    ]);
    const root = spans.find((span) => span.name.startsWith('invoke_agent'));
    const render = spans.find((span) => span.name === 'galaxie.render');
    expect(render?.parentSpanContext?.spanId).toBe(root?.spanContext().spanId);
    await f.instance.cancel(runId);
    expect(renderEvents(await collect(f.instance.events(runId)))).toMatchObject([
      { status: 'failed', code: 'unsupported' },
    ]);
  } finally {
    f.resumeGate.resolve();
    await f.settle();
    await f.runtime.dispose();
  }
});

test('tracing records each outcome as a child span, also after the root closes', () => {
  const { exporter, provider } = createSpanRecorder();
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
  instrumentation.recordRender('failed', 'invalid');
  instrumentation.recordRender('rendered');
  instrumentation.finish('waiting_input');
  instrumentation.recordRender('failed', 'denied');
  const spans = exporter.getFinishedSpans();
  assertSpanTree(spans);
  expect(renderSpans(spans)).toEqual([
    { 'galaxie.render.status': 'failed', 'galaxie.render.error.code': 'invalid' },
    { 'galaxie.render.status': 'rendered' },
    { 'galaxie.render.status': 'failed', 'galaxie.render.error.code': 'denied' },
  ]);
});
