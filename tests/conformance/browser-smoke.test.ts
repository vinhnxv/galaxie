// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { Annotation, END, START, StateGraph } from '@langchain/langgraph/web';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import { expect, test } from 'vitest';

test('loads the web graph and tracing SDK without Node polyfills', async ({ task }) => {
  if (task.file.projectName === 'browser (chromium)') {
    expect(typeof window).toBe('object');
    expect(navigator.userAgent).toContain('HeadlessChrome/');
  } else {
    expect(task.file.projectName).toBe('node');
    expect(typeof window).toBe('undefined');
  }
  const state = Annotation.Root({ value: Annotation<number> });
  const graph = new StateGraph(state)
    .addNode('increment', ({ value }) => ({ value: value + 1 }))
    .addNode('double', ({ value }) => ({ value: value * 2 }))
    .addEdge(START, 'increment')
    .addEdge('increment', 'double')
    .addEdge('double', END)
    .compile();
  expect(await graph.invoke({ value: 2 })).toEqual({ value: 6 });

  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter })],
  });
  try {
    provider.getTracer('browser-smoke').startSpan('smoke').end();
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.ended).toBe(true);
    expect(spans[0]?.spanContext().traceId).toMatch(/^[a-f0-9]{32}$/);
  } finally {
    await provider.shutdown();
  }
});
