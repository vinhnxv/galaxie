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

matrixTest.each([
  'remove gap',
  'invent gap',
  'missing proposed fix',
  'bad pointer',
  'unknown disposition',
  'bad issue',
])('committed gap audit rejects %s', (mutation) => {
  const value = readMatrix();
  auditMatrix(value);
  const gap = value.gaps[0];
  expect(gap, 'Measured missing-span control must have a gap').toBeDefined();
  if (!gap) throw new Error('Missing gap mutation control');
  if (mutation === 'remove gap') value.gaps = value.gaps.slice(1);
  if (mutation === 'invent gap')
    value.gaps.push({ ...gap, name: 'unmeasured-family-span-coverage' });
  if (mutation === 'missing proposed fix') Reflect.deleteProperty(gap, 'proposedFix');
  if (mutation === 'bad pointer')
    gap.evidence = [{ file: 'coverage-matrix.json', path: '/missing' }];
  if (mutation === 'unknown disposition') Reflect.set(gap, 'disposition', 'unverified');
  if (mutation === 'bad issue') gap.beadsIssue = 'not-an-issue';
  expect(() => auditMatrix(value)).toThrow();
});

matrixTest.each([null, '', undefined])('committed in-memory column rejects %s', (replacement) => {
  const value = readMatrix();
  const row = value.rows['pyodide-langgraph-python'];
  expect(row.measurement).toBe('measured');
  if (row.measurement !== 'measured') throw new Error('Missing in-memory mutation control');
  Reflect.set(row.spans.root, 'mlflow', replacement);
  expect(() => auditMatrix(value)).toThrow('must say not measured: maintainer decision');
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
