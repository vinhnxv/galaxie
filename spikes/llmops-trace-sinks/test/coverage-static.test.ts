// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { auditMatrix, type CoverageMatrix, type MeasuredRow } from '../src/coverage.js';

const path = new URL('../results/coverage-matrix.json', import.meta.url);
const matrixTest = test;

function readMatrix(): CoverageMatrix {
  return JSON.parse(readFileSync(path, 'utf8')) as CoverageMatrix;
}

matrixTest('committed coverage matrix accounts for every family and derived gap', () => {
  auditMatrix(readMatrix(), { requireIds: process.env['LLMOPS_REQUIRE_GAP_IDS'] === '1' });
});

const gapMutations = {
  'remove gap': 'Gap set differs',
  'invent gap': 'Gap set differs',
  'missing proposed fix': 'missing proposed fix',
  'wrong evidence pointer': 'evidence differs from gap',
  'unknown disposition': 'unknown disposition',
  'bad issue': 'invalid issue ID',
} as const;

matrixTest.each(Object.entries(gapMutations))(
  'committed gap audit rejects %s',
  (mutation, message) => {
    const value = readMatrix();
    auditMatrix(value);
    const gap = value.gaps[0];
    expect(gap, 'Measured missing-span control must have a gap').toBeDefined();
    if (!gap) throw new Error('Missing gap mutation control');
    if (mutation === 'remove gap') value.gaps = value.gaps.slice(1);
    if (mutation === 'invent gap')
      value.gaps.push({ ...gap, name: 'unmeasured-family-span-coverage' });
    if (mutation === 'missing proposed fix') Reflect.deleteProperty(gap, 'proposedFix');
    if (mutation === 'wrong evidence pointer')
      gap.evidence = [{ file: 'coverage-matrix.json', path: '/missing' }];
    if (mutation === 'unknown disposition') Reflect.set(gap, 'disposition', 'unverified');
    if (mutation === 'bad issue') gap.beadsIssue = 'not-an-issue';
    expect(() => auditMatrix(value)).toThrow(message);
  },
);

matrixTest.each([
  [
    'pyodide-langgraph-python',
    'model calls differ from the script',
    (row: MeasuredRow) => Reflect.set(row.controls ?? {}, 'modelCalls', 0),
  ],
  [
    'adk-go',
    'golden transcript control failed',
    (row: MeasuredRow) => Reflect.set(row.controls ?? {}, 'goldenTranscriptMatched', false),
  ],
  [
    'adk-go',
    'unexpected root executor ID',
    (row: MeasuredRow) => {
      row.executorId = 'bogus';
    },
  ],
  [
    'pyodide-langgraph-python',
    'output control failed',
    (row: MeasuredRow) => Reflect.set(row.controls ?? {}, 'outputCorrect', false),
  ],
  [
    'adk-js',
    'usage differs from emitted usage',
    (row: MeasuredRow) => {
      if (typeof row.usage === 'object' && Array.isArray(row.usage.mlflow))
        row.usage.mlflow[0] = { name: 'chat', present: true, input: 9, output: 9, total: 18 };
    },
  ],
  [
    'adk-js',
    'model type missing',
    (row: MeasuredRow) => {
      const column = row.spans.model.langfuse;
      if (typeof column === 'object') column.types[0] = null;
    },
  ],
  [
    'langgraph-js',
    'names differ from emitted names',
    (row: MeasuredRow) => {
      const column = row.spans.node.mlflow;
      if (typeof column === 'object') column.names[0] = 'galaxie.node other';
    },
  ],
  [
    'langgraph-js',
    'has an unexpected parent',
    (row: MeasuredRow) => {
      const entry = row.tree.find((item) => item.kind === 'capability');
      if (entry) entry.parentName = null;
    },
  ],
] as const)('committed %s row audit rejects: %s', (id, message, mutate) => {
  const value = readMatrix();
  mutate(value.rows[id] as MeasuredRow);
  expect(() => auditMatrix(value)).toThrow(message);
});

matrixTest.each([null, '', undefined])('committed in-memory column rejects %s', (replacement) => {
  const value = readMatrix();
  const row = value.rows['pyodide-langgraph-python'];
  expect(row.measurement).toBe('measured');
  if (row.measurement !== 'measured') throw new Error('Missing in-memory mutation control');
  Reflect.set(row.spans.root, 'mlflow', replacement);
  expect(() => auditMatrix(value)).toThrow('must say not measured: maintainer decision');
});

matrixTest.each([
  ['rawResponsesScanned', 'raw scan control failed'],
  ['spanIdsAndParentsMatch', 'span and parent control failed'],
] as const)('committed live row rejects a false %s control', (control, message) => {
  for (const id of ['langgraph-js', 'adk-js', 'adk-js-own-spans'] as const) {
    const value = readMatrix();
    Reflect.set((value.rows[id] as MeasuredRow).controls ?? {}, control, false);
    expect(() => auditMatrix(value), id).toThrow(message);
  }
});

matrixTest('committed live row rejects a missing backend column', () => {
  const value = readMatrix();
  const row = value.rows['langgraph-js'] as MeasuredRow;
  Reflect.deleteProperty(row.spans.root, 'langfuse');
  expect(() => auditMatrix(value)).toThrow('missing live langfuse column');
});

matrixTest('committed matrix rejects an unexplained unmeasured family', () => {
  const value = readMatrix();
  const row = value.rows['adk-go'];
  value.rows['adk-go'] = {
    id: row.id,
    measurement: 'unmeasured',
    fixture: row.fixture,
    scriptedCalls: row.scriptedCalls,
    probes: ['go env GOVERSION: exit 0'],
    reason: '',
  };
  expect(() => auditMatrix(value)).toThrow('missing unmeasured reason');
});
