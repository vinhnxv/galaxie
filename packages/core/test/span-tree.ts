// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import { expect } from 'vitest';
import metadata from '../package.json' with { type: 'json' };

export interface SpanTree {
  readonly name: string;
  readonly children: SpanTree[];
}

/** SDK span objects retain circular processor references; inspect the public telemetry fields. */
export function serializeSpans(spans: readonly ReadableSpan[]): string {
  return JSON.stringify(
    spans.map((span) => ({
      name: span.name,
      kind: span.kind,
      context: span.spanContext(),
      parent: span.parentSpanContext,
      attributes: span.attributes,
      status: span.status,
      events: span.events,
      links: span.links,
      scope: span.instrumentationScope,
      startTime: span.startTime,
      endTime: span.endTime,
    })),
  );
}

const ALLOWED = new Set([
  'gen_ai.operation.name',
  'gen_ai.tool.name',
  'galaxie.capability.kind',
  'galaxie.destination.class',
  'galaxie.run.labels',
  'galaxie.budget.name',
  'gen_ai.agent.name',
  'galaxie.app.id',
  'galaxie.agent.version',
  'galaxie.instance.id',
  'galaxie.session.id',
  'galaxie.run.id',
  'galaxie.executor.id',
  'galaxie.executor.version',
  'galaxie.run.status',
  'error.type',
  'galaxie.error.code',
  'galaxie.node.name',
  'galaxie.node.step',
  'galaxie.step.status',
  'gen_ai.provider.name',
  'gen_ai.request.model',
  'gen_ai.response.model',
  'gen_ai.usage.input_tokens',
  'gen_ai.usage.output_tokens',
]);

/** Independent tree and allowlist check, reused by the adapter's Node and browser tests. */
export function assertSpanTree(spans: readonly ReadableSpan[]): SpanTree {
  expect(spans.length, 'No spans: check for a duplicate @opentelemetry/api copy.').toBeGreaterThan(
    0,
  );
  for (const span of spans) {
    expect(span.instrumentationScope.name).toBe('@galaxie/core');
    expect(span.instrumentationScope.version).toBe(metadata.version);
    expect(span.events).toEqual([]);
    expect(span.links).toEqual([]);
    expect(span.status.message).toBeUndefined();
    expect(span.ended).toBe(true);
    for (const [key, value] of Object.entries(span.attributes)) {
      expect(ALLOWED.has(key), key).toBe(true);
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) {
        expect(['string', 'number', 'boolean']).toContain(typeof item);
        if (typeof item === 'number') expect(Number.isFinite(item)).toBe(true);
        if (typeof item === 'string') expect(item).toMatch(/^[^\p{Cc}]{1,128}$/u);
        expect(typeof item).toBe(typeof values[0]);
      }
    }
  }
  const ids = new Set(spans.map((span) => span.spanContext().spanId));
  const roots = spans.filter(
    (span) => !span.parentSpanContext || !ids.has(span.parentSpanContext.spanId),
  );
  expect(roots).toHaveLength(1);
  const build = (span: ReadableSpan): SpanTree => ({
    name: span.name,
    children: spans
      .filter((child) => child.parentSpanContext?.spanId === span.spanContext().spanId)
      .map(build)
      .sort((a, b) => a.name.localeCompare(b.name)),
  });
  const root = roots[0];
  if (!root) throw new Error('The run span is missing.');
  return build(root);
}

/** Shares the SDK already installed for core tests with adapter tests. */
export function createSpanRecorder(): {
  readonly exporter: InMemorySpanExporter;
  readonly provider: TracerProvider;
} {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  return { exporter, provider };
}
