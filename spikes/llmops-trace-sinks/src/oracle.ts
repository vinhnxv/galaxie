// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createTraceState, type SpanContext } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';

type ContextSnapshot = Omit<SpanContext, 'traceState'> & { traceState?: string };
export interface SpanSnapshot
  extends Omit<ReadableSpan, 'spanContext' | 'parentSpanContext' | 'resource' | 'links'> {
  context: ContextSnapshot;
  parent: ContextSnapshot | null;
  resource: { attributes: ReadableSpan['attributes']; schemaUrl?: string };
  links: (Omit<ReadableSpan['links'][number], 'context'> & { context: ContextSnapshot })[];
}

function snapshotContext(context: SpanContext): ContextSnapshot {
  const { traceState, ...rest } = context;
  return { ...rest, ...(traceState === undefined ? {} : { traceState: traceState.serialize() }) };
}

function decodeContext(context: ContextSnapshot): SpanContext {
  const { traceState, ...rest } = context;
  return {
    ...rest,
    ...(traceState === undefined ? {} : { traceState: createTraceState(traceState) }),
  };
}

export function snapshotSpans(spans: readonly ReadableSpan[]): SpanSnapshot[] {
  return spans.map((span) => ({
    name: span.name,
    kind: span.kind,
    context: snapshotContext(span.spanContext()),
    parent: span.parentSpanContext ? snapshotContext(span.parentSpanContext) : null,
    attributes: span.attributes,
    status: { ...span.status },
    events: [...span.events],
    links: span.links.map((link) => ({ ...link, context: snapshotContext(link.context) })),
    instrumentationScope: span.instrumentationScope,
    ended: span.ended,
    startTime: span.startTime,
    endTime: span.endTime,
    duration: span.duration,
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
    resource: {
      attributes: span.resource.attributes,
      ...(span.resource.schemaUrl === undefined ? {} : { schemaUrl: span.resource.schemaUrl }),
    },
  }));
}

export function decodeSpans(snapshot: readonly SpanSnapshot[]): ReadableSpan[] {
  return snapshot.map(({ context, parent, resource, links, ...fields }) => ({
    ...fields,
    spanContext: () => decodeContext(context),
    ...(parent === null ? {} : { parentSpanContext: decodeContext(parent) }),
    links: links.map((link) => ({ ...link, context: decodeContext(link.context) })),
    resource: resourceFromAttributes(
      resource.attributes,
      resource.schemaUrl === undefined ? {} : { schemaUrl: resource.schemaUrl },
    ),
  }));
}
