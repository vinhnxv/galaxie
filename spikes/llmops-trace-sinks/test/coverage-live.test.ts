// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type Context, context, ROOT_CONTEXT } from '@opentelemetry/api';
import { type ReadableSpan, StackContextManager } from '@opentelemetry/sdk-trace';
import { afterAll, expect, test } from 'vitest';
import {
  auditMatrix,
  buildRow,
  buildUnmeasuredRow,
  type CoverageMatrix,
  type CoverageRow,
  deriveGaps,
  kindOf,
  type RowId,
} from '../src/coverage.js';
import { coverageReadback, scanMarkers } from '../src/coverage-readback.js';
import { type CoverageProvider, createProvider } from '../src/families/provider.js';
import { canary } from '../src/host.js';
import { prompt, reply, runScenario } from '../src/scenarios.js';

const live = test.skipIf(process.env['LLMOPS_STACK'] !== '1');

// ADK writes attributes after awaits. This Node-only control needs async context;
// the measured run deliberately has no context manager.
class ControlContext extends StackContextManager {
  readonly storage = new AsyncLocalStorage<Context>();
  override active(): Context {
    return this.storage.getStore() ?? ROOT_CONTEXT;
  }
  override with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    activeContext: Context | null,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return this.storage.run(activeContext ?? ROOT_CONTEXT, () => fn.call(thisArg, ...args));
  }
}
const rows: Partial<Record<RowId, CoverageRow>> = {};
let own: CoverageProvider | undefined;
const fixture = {
  'langgraph-js': [
    'src/scenarios.ts#tool-call',
    'tests/conformance/support/scripted-chat-model.ts',
  ],
  'adk-js': [
    'tests/conformance/support/adk.ts#runAdkGalaxie',
    'tests/conformance/cases-adk/fixtures.json#capability',
  ],
  'adk-js-own-spans': ['tests/conformance/cases-adk/fixtures.json#capability'],
  'pyodide-langgraph-python': [
    'examples/rag-browser/test/support/python.node.ts',
    'tests/conformance/pyodide.node.test.ts',
  ],
  'adk-go': [
    'examples/rag-browser/test/support/adk-go-ref/run.ts',
    'examples/rag-browser/test/support/adk-go-reference.node.ts',
    'tests/conformance/cases-adk-go/scripts.json#capability-tool',
    'tests/conformance/golden-adk-go/capability-tool.json',
  ],
};

function assertShape(
  spans: readonly ReadableSpan[],
  counts: Record<string, number>,
  usage?: { input: number; output: number; total: number },
): void {
  expect(spans.length).toBe(Object.values(counts).reduce((sum, count) => sum + count, 0));
  for (const [kind, count] of Object.entries(counts))
    expect(
      spans.filter((span) => kindOf(span) === kind),
      kind,
    ).toHaveLength(count);
  if (usage)
    for (const span of spans.filter((span) => kindOf(span) === 'model')) {
      expect(span.attributes['gen_ai.usage.input_tokens']).toBe(usage.input);
      expect(span.attributes['gen_ai.usage.output_tokens']).toBe(usage.output);
    }
}

afterAll(async () => {
  await own?.shutdown();
});

live(
  'LangGraph baseline matches both backends by span ID, parent and usage',
  async () => {
    const result = await runScenario('tool-call', { text: false, live: true });
    expect(result.credentialCalls).toBeGreaterThan(0);
    expect(result.traceIds).toHaveLength(1);
    assertShape(
      result.spans,
      { root: 1, node: 2, model: 1, capability: 1 },
      { input: 2, output: 3, total: 5 },
    );
    const backends = await coverageReadback(result.spans, [
      canary,
      prompt,
      reply,
      'synthetic lookup argument',
      'synthetic capability result',
      'synthetic public input',
    ]);
    for (const source of result.spans) {
      const kind = kindOf(source);
      for (const [backend, records] of Object.entries(backends)) {
        const stored = records.find((span) => span.id === source.spanContext().spanId);
        if (kind === 'root' || kind === 'model' || kind === 'capability')
          expect(stored?.type).toBe(
            kind === 'root'
              ? 'AGENT'
              : kind === 'capability'
                ? 'TOOL'
                : backend === 'langfuse'
                  ? 'GENERATION'
                  : 'CHAT_MODEL',
          );
        if (kind === 'model')
          expect(stored?.usage).toEqual(
            backend === 'langfuse'
              ? { input: 2, output: 3, total: 5 }
              : { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
          );
      }
    }
    const row = buildRow({
      id: 'langgraph-js',
      spans: result.spans,
      fixture: fixture['langgraph-js'],
      scriptedCalls: { model: 1, capability: 1 },
      backends,
      controls: {
        credentialCalls: result.credentialCalls,
        spanIdsAndParentsMatch: true,
        rawResponsesScanned: true,
      },
    });
    expect(row.executorId).toBe('langgraph-js');
    rows['langgraph-js'] = row;
  },
  180_000,
);

live(
  'ADK content control stays in memory; measured galaxie and own spans reach both backends',
  async () => {
    own = createProvider({ live: true, global: true });
    const { runAdk, adkMarkers } = await import('../src/families/adk-js.js');
    // ADK writes attributes onto the active span. Without a context manager its spans
    // are empty even with capture enabled, so activate spans only for this memory control.
    const controlContext = new ControlContext().enable();
    assert.ok(context.setGlobalContextManager(controlContext));
    try {
      await runAdk(own, true);
    } finally {
      context.disable();
    }
    const control = own.oracle.getFinishedSpans();
    expect(control.length).toBeGreaterThan(0);
    const controlAttributes = control.map((span) => span.attributes);
    for (const marker of adkMarkers) {
      expect(JSON.stringify(controlAttributes)).toContain(marker);
      expect(() => scanMarkers(controlAttributes, [marker])).toThrow('Trace content marker');
    }
    // Force-flush occurred while the forwarding gate was closed, then discard the control oracle.
    own.oracle.reset();
    own.setExportEnabled(true);
    const result = await runAdk(own, false);
    assertShape(
      result.spans,
      { root: 1, node: 1, model: 2, capability: 1 },
      { input: 2, output: 2, total: 4 },
    );
    const ownSpans = own.oracle.getFinishedSpans();
    expect(ownSpans.length).toBeGreaterThan(0);
    expect(ownSpans.every((span) => span.instrumentationScope.name === 'gcp.vertex.agent')).toBe(
      true,
    );
    scanMarkers(
      [...result.spans, ...ownSpans].map((span) => span.attributes),
      [canary, ...adkMarkers],
    );
    const all = [...result.spans, ...ownSpans];
    const stored = await coverageReadback(all, [canary, ...adkMarkers]);
    const subset = (spans: readonly ReadableSpan[]): typeof stored => {
      const ids = new Set(spans.map((span) => span.spanContext().spanId));
      return {
        langfuse: stored.langfuse.filter((span) => ids.has(span.id)),
        mlflow: stored.mlflow.filter((span) => ids.has(span.id)),
      };
    };
    const backends = subset(result.spans);
    for (const source of result.spans.filter((span) => kindOf(span) === 'model'))
      for (const [backend, records] of Object.entries(backends))
        expect(records.find((span) => span.id === source.spanContext().spanId)?.usage).toEqual(
          backend === 'langfuse'
            ? { input: 2, output: 2, total: 4 }
            : { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
        );
    rows['adk-js'] = buildRow({
      id: 'adk-js',
      spans: result.spans,
      fixture: fixture['adk-js'],
      scriptedCalls: { model: 2, capability: 1 },
      backends,
      controls: {
        modelCalls: result.modelCalls,
        capabilityCalls: result.capabilityCalls,
        outputCorrect: result.outputCorrect,
        spanIdsAndParentsMatch: true,
        rawResponsesScanned: true,
        captureMessageContent: false,
      },
      versions: {
        adk: JSON.parse(
          readFileSync(
            new URL('../node_modules/@google/adk/package.json', import.meta.url),
            'utf8',
          ),
        ).version,
      },
    });
    expect(rows['adk-js'].executorId).toBe('adk-js');
    const rootTrace = result.spans.find((span) => kindOf(span) === 'root')?.spanContext().traceId;
    rows['adk-js-own-spans'] = buildRow({
      id: 'adk-js-own-spans',
      spans: ownSpans,
      fixture: fixture['adk-js-own-spans'],
      scriptedCalls: { model: 2, capability: 1 },
      backends: subset(ownSpans),
      controls: {
        contentControlDetected: true,
        controlContextManager: 'Node AsyncLocalStorage; in-memory control only',
        measuredContextManager: 'none',
        controlMarkersDetected: adkMarkers.length,
        measuredContentAbsent: true,
        spanIdsAndParentsMatch: true,
        rawResponsesScanned: true,
        sharesGalaxieTrace: ownSpans.some((span) => span.spanContext().traceId === rootTrace),
        traceCount: new Set(ownSpans.map((span) => span.spanContext().traceId)).size,
      },
    });
    own.setExportEnabled(false);
  },
  180_000,
);

live(
  'Pyodide LangGraph Python records an in-memory tree with execution controls',
  async () => {
    const { runPyodide } = await import('../src/families/pyodide.js');
    const result = await runPyodide();
    if (result.measurement === 'measured')
      expect(
        result.spans.some((span) => span.instrumentationScope.name === 'gcp.vertex.agent'),
      ).toBe(false);
    const common = {
      id: 'pyodide-langgraph-python' as const,
      fixture: fixture['pyodide-langgraph-python'],
      scriptedCalls: { model: 1, capability: 1 },
    };
    rows['pyodide-langgraph-python'] =
      result.measurement === 'unmeasured'
        ? buildUnmeasuredRow({ ...common, reason: result.reason, probes: result.probes })
        : buildRow({
            ...common,
            spans: result.spans,
            versions: result.versions,
            controls: {
              modelCalls: result.modelCalls,
              capabilityCalls: result.capabilityCalls,
              outputCorrect: result.outputCorrect,
              noAdkOwnSpans: result.spans.every(
                (span) => span.instrumentationScope.name !== 'gcp.vertex.agent',
              ),
            },
          });
  },
  240_000,
);

live(
  'Go records its in-memory tree against the independent golden transcript',
  async () => {
    const { runGo } = await import('../src/families/go.js');
    const result = await runGo();
    if (result.measurement === 'measured')
      expect(
        result.spans.some((span) => span.instrumentationScope.name === 'gcp.vertex.agent'),
      ).toBe(false);
    const common = {
      id: 'adk-go' as const,
      fixture: fixture['adk-go'],
      scriptedCalls: { model: 2, capability: 1 },
    };
    rows['adk-go'] =
      result.measurement === 'unmeasured'
        ? buildUnmeasuredRow({ ...common, reason: result.reason, probes: result.probes })
        : buildRow({
            ...common,
            spans: result.spans,
            versions: result.versions,
            controls: {
              modelCalls: result.modelCalls,
              capabilityCalls: result.capabilityCalls,
              outputCorrect: result.outputCorrect,
              goldenTranscriptMatched: result.goldenMatched,
              noAdkOwnSpans: result.spans.every(
                (span) => span.instrumentationScope.name !== 'gcp.vertex.agent',
              ),
            },
          });
  },
  300_000,
);

live('assemble and atomically format a complete matrix only after all families ran', () => {
  for (const id of Object.keys(fixture)) assert.ok(rows[id as RowId], `Missing coverage row ${id}`);
  const matrix: CoverageMatrix = {
    scenario: {
      description:
        'One capability call preceded by model calls; tool-calling loops require a second model call after the result.',
      text: false,
      pythonAndGoBackends: 'not measured: maintainer decision',
      vendorTelemetry: 'Langfuse and MLflow defaults, by maintainer decision',
    },
    rows: rows as Record<RowId, CoverageRow>,
    gaps: deriveGaps(rows as Record<RowId, CoverageRow>),
    notMeasured: [
      'ADK Python, DSPy and Pydantic AI drivers',
      'Browsers, engines and real devices',
      'Real models and answer quality',
      'ADK span nesting with a context manager',
      'Langfuse and MLflow classification of Python and Go trees: maintainer decision',
      'Delivery guarantees, retries, capacity and latency',
      'Vendor telemetry payloads and all container egress',
    ],
  };
  auditMatrix(matrix);
  const formatted = execFileSync(
    fileURLToPath(new URL('../../../node_modules/.bin/biome', import.meta.url)),
    ['format', '--stdin-file-path', 'results/coverage-matrix.json'],
    { input: `${JSON.stringify(matrix, null, 2)}\n`, encoding: 'utf8' },
  );
  const destination = new URL('../results/coverage-matrix.json', import.meta.url);
  const temporary = new URL('../results/coverage-matrix.json.tmp', import.meta.url);
  writeFileSync(temporary, formatted);
  renameSync(temporary, destination);
});
