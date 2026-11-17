// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import {
  assertResultHygiene,
  auditMatrix,
  buildRow,
  buildUnmeasuredRow,
  type CoverageMatrix,
  type CoverageSpan,
  coverageRowIds,
  deriveGaps,
  type MeasuredRow,
  type RowId,
  type StoredSpan,
} from '../src/coverage.js';

const baseline = JSON.parse(
  readFileSync(new URL('../results/node-tool-call.json', import.meta.url), 'utf8'),
) as { variants: { backends: { langfuse: StoredSpan[]; mlflow: StoredSpan[] } }[] };
const first = baseline.variants[0];
if (!first) throw new Error('Missing recorded baseline control');
const records = first.backends;

function emitted(records: StoredSpan[]): CoverageSpan[] {
  return records.map((span) => ({
    name: span.name === 'lookup@1' ? 'execute_tool lookup@1' : span.name,
    attributes: span.attributes,
    ...(span.parentId ? { parentSpanContext: { spanId: span.parentId } } : {}),
    spanContext: () => ({ spanId: span.id, traceId: span.traceId }),
  }));
}

const executors: Partial<Record<RowId, string>> = {
  'langgraph-js': 'langgraph-js',
  'adk-js': 'adk-js',
  'pyodide-langgraph-python': 'langgraph-python',
  'adk-go': 'adk-go',
};

function row(id: RowId = 'langgraph-js', spans = emitted(records.langfuse)): MeasuredRow {
  const live = id === 'langgraph-js' || id === 'adk-js' || id === 'adk-js-own-spans';
  const adapted = spans.map((span) =>
    id === 'adk-js-own-spans'
      ? { ...span, attributes: {} }
      : span.attributes['gen_ai.operation.name'] === 'invoke_agent'
        ? { ...span, attributes: { ...span.attributes, 'galaxie.executor.id': executors[id] } }
        : span,
  );
  return buildRow({
    id,
    spans: adapted,
    fixture: ['results/node-tool-call.json'],
    scriptedCalls: { model: 1, capability: 1 },
    ...(live ? { backends: records } : {}),
    ...(live
      ? { controls: { rawResponsesScanned: true, spanIdsAndParentsMatch: true } }
      : {
          controls: {
            modelCalls: 1,
            capabilityCalls: 1,
            outputCorrect: true,
            ...(id === 'adk-go' ? { goldenTranscriptMatched: true } : {}),
          },
        }),
  });
}

function matrix(): CoverageMatrix {
  const rows = Object.fromEntries(
    coverageRowIds.map((id) => [id, row(id)]),
  ) as CoverageMatrix['rows'];
  rows['pyodide-langgraph-python'] = row(
    'pyodide-langgraph-python',
    emitted(records.langfuse).filter((span) =>
      ['invoke_agent', 'execute_tool'].includes(String(span.attributes['gen_ai.operation.name'])),
    ),
  );
  return { scenario: 'Synthetic audit control', rows, gaps: deriveGaps(rows), notMeasured: [] };
}

test('recorded backend control builds the baseline kinds, classifications and usage', () => {
  const result = row();
  expect(result.executorId).toBe('langgraph-js');
  expect(
    Object.fromEntries(
      Object.entries(result.spans).map(([key, value]) => [key, value.emitted.count]),
    ),
  ).toEqual({ root: 1, node: 2, model: 1, capability: 1, other: 0 });
  for (const [kind, langfuse, mlflow] of [
    ['root', ['AGENT'], ['AGENT']],
    ['node', ['SPAN', 'SPAN'], [null, null]],
    ['model', ['GENERATION'], ['CHAT_MODEL']],
    ['capability', ['TOOL'], ['TOOL']],
  ] as const) {
    expect(result.spans[kind].langfuse).toMatchObject({ types: [...langfuse] });
    expect(result.spans[kind].mlflow).toMatchObject({ types: [...mlflow] });
  }
  expect(result.usage).toMatchObject({
    emitted: [{ name: 'chat fixture-1', present: true, input: 2, output: 3, total: 5 }],
    langfuse: [{ name: 'chat fixture-1', present: true, input: 2, output: 3, total: 5 }],
    mlflow: [{ name: 'chat fixture-1', present: true, input: 2, output: 3, total: 5 }],
  });
  expect(result.tree).toContainEqual({
    name: 'execute_tool lookup@1',
    kind: 'capability',
    parentName: 'galaxie.node lookup',
  });
});

test('root and capability positive control produces exactly the missing-span gap', () => {
  const value = matrix();
  const result = value.rows['pyodide-langgraph-python'];
  expect(result.measurement).toBe('measured');
  if (result.measurement !== 'measured') throw new Error('Missing measured control');
  expect(result.spans.root.emitted.count).toBe(1);
  expect(result.spans.capability.emitted.count).toBe(1);
  expect(result.spans.node.emitted.count).toBe(0);
  expect(result.spans.model.emitted.count).toBe(0);
  expect(result.usage).toBe('not applicable: no model spans');
  expect(value.gaps.map((gap) => gap.name)).toEqual(['pyodide-langgraph-python-span-coverage']);
  expect(value.gaps[0]?.finding).toContain('node and model');
  auditMatrix(value);
});

test('model usage gap requires a model without complete token usage', () => {
  const spans = emitted(records.langfuse).map((span) => ({
    ...span,
    attributes: { ...span.attributes },
  }));
  const model = spans.find((span) => span.attributes['gen_ai.operation.name'] === 'chat');
  if (!model) throw new Error('Missing model positive control');
  delete model.attributes['gen_ai.usage.input_tokens'];
  const result = row('adk-go', spans);
  expect(deriveGaps({ 'adk-go': result }).map((gap) => gap.name)).toEqual(['adk-go-model-usage']);
  expect(deriveGaps({ 'adk-js-own-spans': { ...result, id: 'adk-js-own-spans' } })).toEqual([]);
});

test.each([
  'remove gap',
  'invent gap',
  'missing proposed fix',
  'bad pointer',
  'unknown disposition',
  'bad issue',
])('matrix audit rejects %s', (mutation) => {
  const value = matrix();
  const gap = value.gaps[0];
  if (!gap) throw new Error('Missing gap positive control');
  if (mutation === 'remove gap') value.gaps = [];
  if (mutation === 'invent gap') value.gaps.push({ ...gap, name: 'adk-js-span-coverage' });
  if (mutation === 'missing proposed fix') gap.proposedFix = '';
  if (mutation === 'bad pointer')
    gap.evidence = [{ file: 'coverage-matrix.json', path: '/missing' }];
  if (mutation === 'unknown disposition') Reflect.set(gap, 'disposition', 'unverified');
  if (mutation === 'bad issue') gap.beadsIssue = 'not-an-issue';
  expect(() => auditMatrix(value)).toThrow(
    {
      'remove gap': 'Gap set differs',
      'invent gap': 'Gap set differs',
      'missing proposed fix': 'missing proposed fix',
      'bad pointer': 'evidence differs from gap',
      'unknown disposition': 'unknown disposition',
      'bad issue': 'invalid issue ID',
    }[mutation],
  );
});

test('strict issue audit rejects pending IDs and accepts a real issue ID', () => {
  const value = matrix();
  auditMatrix(value);
  expect(() => auditMatrix(value, { requireIds: true })).toThrow('PENDING-CLAUDE');
  const gap = value.gaps[0];
  if (!gap) throw new Error('Missing issue positive control');
  gap.beadsIssue = 'galaxie-d53.8';
  auditMatrix(value);
  auditMatrix(value, { requireIds: true });
  gap.beadsIssue = 'not-an-issue';
  expect(() => auditMatrix(value)).toThrow('invalid issue ID');
  expect(() => auditMatrix(value, { requireIds: true })).toThrow('invalid issue ID');
});

test.each([null, '', undefined])('in-memory backend columns reject %s', (replacement) => {
  const value = matrix();
  const result = value.rows['pyodide-langgraph-python'];
  if (result.measurement !== 'measured') throw new Error('Missing memory positive control');
  Reflect.set(result.spans.root, 'langfuse', replacement);
  expect(() => auditMatrix(value)).toThrow('must say not measured: maintainer decision');
});

test('live backend column must be measured', () => {
  const value = matrix();
  const result = value.rows['langgraph-js'];
  if (result.measurement !== 'measured') throw new Error('Missing live positive control');
  Reflect.deleteProperty(result.spans.root, 'mlflow');
  expect(() => auditMatrix(value)).toThrow('missing live mlflow column');
});

test('unmeasured rows require both a reason and probes', () => {
  const value = matrix();
  value.rows['adk-go'] = buildUnmeasuredRow({
    id: 'adk-go',
    fixture: ['tests/conformance/cases-adk-go/scripts.json'],
    scriptedCalls: { model: 2, capability: 1 },
    reason: 'Go toolchain does not match go/wasm.lock',
    probes: ['go env GOVERSION: exit 0, mismatch'],
  });
  auditMatrix(value);
  Reflect.deleteProperty(value.rows['adk-go'], 'reason');
  expect(() => auditMatrix(value)).toThrow('missing unmeasured reason');
});

test.each([
  '0123456789abcdef0123456789abcdef',
  '2026-11-15T09:31:00.000Z',
  '/Users/example/private',
  '/home/example/cache',
  '/private/tmp/example',
  '/opt/homebrew/Cellar/go',
  '/usr/local/go/bin',
])('result hygiene rejects machine value %s', (value) => {
  expect(() => assertResultHygiene(JSON.stringify({ value }))).toThrow(
    /Generated trace ID|Timestamp|Machine-specific/,
  );
});

test('result hygiene permits repo-relative fixtures and fixed version strings', () => {
  assertResultHygiene(
    JSON.stringify({ fixture: 'tests/conformance/cases-adk/fixtures.json', version: '2.3.0' }),
  );
});
