// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'vitest';
import { z } from 'zod';
import * as mini from 'zod/mini';
import { readAnnotations } from '../src/annotations.js';
import { galaxieField, type Schema } from '../src/index.js';

const privateField = galaxieField({ label: 'private-user' });
test('labels nested objects, arrays, definitions and unlabelled leaves', () => {
  const schema = z.object({ a: z.array(z.string().meta(privateField)), b: z.number() });
  expect([...readAnnotations(schema).labels].sort()).toEqual(['app', 'private-user']);
  const custom = schemaWith({
    $defs: { x: { type: 'string', 'x-galaxie': { label: 'public' } } },
    $ref: '#/$defs/x',
  });
  expect([...readAnnotations(custom).labels]).toEqual(['public']);
});
test.each([
  [z.enum(['a', 'b']), 'enum'],
  [z.literal('a'), 'enum'],
  [z.uuid(), 'id'],
  [
    z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .max(64),
    'id',
  ],
  [
    z
      .string()
      .regex(/^[a-z]+$/)
      .max(200),
    'pattern',
  ],
  [z.string(), 'freeText'],
  [
    z
      .string()
      .regex(/^[\w\s]+$/)
      .max(200),
    'freeText',
  ],
  [z.string().regex(/^.*$/).max(100), 'freeText'],
  [z.string().regex(/^[a-z ]{1,100}$/), 'freeText'],
])('infers constraints without widening declarations: %s', (field, shape) => {
  const annotations = readAnnotations(z.object({ field }));
  expect(annotations.properties.get('field')).toBe(shape);
});
test('rejects a stricter declared shape and unsupported schema walkers', () => {
  expect(() => readAnnotations(z.string().meta(galaxieField({ shape: 'id' })))).toThrowError(
    expect.objectContaining({ code: 'invalid' }),
  );
  for (const schema of [
    schemaWith({ patternProperties: { x: {} } }),
    schemaWith({ $ref: 'https://example.test/schema' }),
    mini.string(),
  ])
    expect(() => readAnnotations(schema)).toThrowError(
      expect.objectContaining({ code: 'unsupported' }),
    );
});
test('unions, transforms and pipe targets retain private labels in either direction', () => {
  for (const schema of [
    z.union([z.string(), z.string().meta(privateField)]),
    z
      .string()
      .meta(privateField)
      .transform((x) => x),
    z.string().pipe(z.string().meta(privateField)),
  ]) {
    const annotations = readAnnotations(schema);
    expect(annotations.labels.has('private-user')).toBe(true);
    expect(annotations.privateStrings('private sentence')).toContain('private sentence');
  }
});
test('unrepresentable positions are unlabelled free text', () => {
  for (const schema of [z.custom(), z.date()]) {
    const annotations = readAnnotations(schema);
    expect([...annotations.labels]).toEqual(['app']);
    expect(annotations.freeTextStrings('anything')).toContain('anything');
  }
});
test('record keys inherit labels and unconstrained keys are free text', () => {
  const annotations = readAnnotations(z.record(z.string(), z.number()).meta(privateField));
  expect(annotations.freeTextStrings({ 'private key': 1 })).toContain('private key');
  expect(annotations.privateStrings({ 'private key': 1 })).toContain('private key');
});
test('private containers include every nested string and recursive children terminate', () => {
  const container = readAnnotations(z.object({ data: z.unknown().meta(privateField) }));
  expect(container.privateStrings({ data: { deep: ['one', { text: 'two' }] } })).toEqual([
    'deep',
    'one',
    'text',
    'two',
  ]);
  const recursive = z.object({
    text: z.string().meta(privateField),
    get child() {
      return recursive.optional();
    },
  });
  expect(
    readAnnotations(recursive).privateStrings({ text: 'first', child: { text: 'nested' } }),
  ).toEqual(['first', 'nested']);
});
function schemaWith(json: Record<string, unknown>): Schema {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: (value: unknown) => ({ value }),
      jsonSchema: { input: () => json, output: () => json },
    },
  } as unknown as Schema;
}
