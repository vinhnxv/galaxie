// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import { cases } from './cases/index.js';
import { diff } from './support/diff.js';
import { parseCompatibilityMatrix } from './support/matrix.js';
import { normalize } from './support/normalize.js';
import { runGalaxie } from './support/transcript.js';

test('normalizes only observed interrupt IDs in first-appearance order, including keys', () => {
  const first = '11111111111111111111111111111111';
  const second = '22222222222222222222222222222222';
  const unrelated = '33333333333333333333333333333333';
  expect(
    normalize({
      events: { updates: [{ data: { __interrupt__: [{ id: first, value: {} }] } }] },
      pauses: [
        { interrupts: [{ id: first, value: {} }] },
        { interrupts: [{ id: second, value: {} }] },
      ],
      state: { [second]: first, unrelated, uuid: '12345678-1234-1234-1234-123456789abc' },
    }),
  ).toEqual({
    events: { updates: [{ data: { __interrupt__: [{ id: '<interrupt:1>', value: {} }] } }] },
    pauses: [
      { interrupts: [{ id: '<interrupt:1>', value: {} }] },
      { interrupts: [{ id: '<interrupt:2>', value: {} }] },
    ],
    state: { '<interrupt:2>': '<interrupt:1>', unrelated, uuid: '<uuid:1>' },
  });
});

test('a non-pausing transcript has no pauses field', async () => {
  expect(await runGalaxie(cases.linear)).not.toHaveProperty('pauses');
});

test('normalizes repeated, distinct and embedded UUIDs in values and keys after JSON serialization', () => {
  const first = '12345678-1234-1234-1234-123456789abc';
  const second = '87654321-4321-4321-4321-cba987654321';
  expect(
    normalize({
      first,
      repeated: first,
      path: `node:${first}`,
      run: `run-${second}`,
      [second]: { toJSON: () => ({ id: second }) },
      omitted: undefined,
    }),
  ).toEqual({
    first: '<uuid:1>',
    repeated: '<uuid:1>',
    path: 'node:<uuid:1>',
    run: 'run-<uuid:2>',
    '<uuid:2>': { id: '<uuid:2>' },
  });
});

test('normalizes ISO timestamps including timestamps embedded in text', () => {
  expect(
    normalize({
      created: new Date('2026-10-28T12:34:56.123Z'),
      text: 'at 2026-10-28T19:34:56+07:00 and 2026-10-28T12:34:56Z',
    }),
  ).toEqual({ created: '<timestamp>', text: 'at <timestamp> and <timestamp>' });
});

test('diff finds changed leaves and added or removed object fields', () => {
  expect(diff({ a: [{ b: 1 }] }, { a: [{ b: 1 }] })).toEqual([]);
  expect(diff({ a: [{ b: 1 }, { b: 2 }] }, { a: [{ b: 1 }, { b: 3 }] })).toEqual(['$.a[1].b']);
  expect(diff({ removed: 1 }, { added: 2 })).toEqual(['$.removed', '$.added']);
});

test('diff collapses an array length mismatch without hiding another stream mode', () => {
  expect(
    diff(
      { events: { messages: [1, 2], updates: [{ value: 1 }] } },
      { events: { messages: [], updates: [{ value: 2 }] } },
    ),
  ).toEqual(['$.events.messages', '$.events.updates[0].value']);
});

const entry = {
  case: 'model-without-config',
  lane: 'galaxie-node',
  differences: ['$.events.messages'],
  reason: 'The web entry does not install async context.',
};

test('loads a matrix with known cases and lanes and no entry for equal transcripts', () => {
  expect(parseCompatibilityMatrix([entry])).toEqual([entry]);
  expect(parseCompatibilityMatrix([])).toEqual([]);
});

test.each([
  { ...entry, reason: '' },
  { ...entry, reason: '   ' },
  { ...entry, case: 'unknown' },
  { ...entry, lane: 'unknown' },
  { ...entry, differences: [] },
  { ...entry, differences: ['$.events.messages', '$.events.messages'] },
])('rejects invalid matrix entry %j', (invalid) => {
  expect(() => parseCompatibilityMatrix([invalid])).toThrow();
});

test('rejects duplicate case and lane matrix entries', () => {
  expect(() => parseCompatibilityMatrix([entry, entry])).toThrow();
});
