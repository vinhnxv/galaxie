// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import { z } from 'zod';
import { type AgentDefinition, createManifest, GalaxieError, galaxieField } from '../src/index.js';

const definition: AgentDefinition = {
  id: 'tests.manifest',
  version: '1.0.0',
  executor: 'fake',
  input: z.string(),
};
const request = { kind: 'read', input: z.string(), output: z.boolean() } as const;
const options = { entry: './dist/index.js' };

test('preserves labels and shapes through input JSON Schema conversion', () => {
  const input = z.object({
    sentence: z.string().meta(galaxieField({ label: 'private-user', shape: 'freeText' })),
    id: z
      .string()
      .max(64)
      .meta(galaxieField({ shape: 'id' })),
  });
  const result = createManifest({ ...definition, input }, options);
  expect(result.schemas['./schemas/input.json']).toMatchObject({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    properties: {
      sentence: { type: 'string', 'x-galaxie': { label: 'private-user', shape: 'freeText' } },
      id: { type: 'string', maxLength: 64, 'x-galaxie': { shape: 'id' } },
    },
  });
});

test('omits absent groups and includes optional capabilities and skills when declared', () => {
  expect(createManifest(definition, options).manifest).toEqual({
    schemaVersion: '0.2',
    id: 'tests.manifest',
    version: '1.0.0',
    executor: 'fake',
    entry: './dist/index.js',
    inputSchema: './schemas/input.json',
  });
  expect(
    createManifest(
      {
        ...definition,
        capabilities: { optional: { 'lookup@1': request } },
        skills: ['./SKILL.md'],
      },
      options,
    ).manifest,
  ).toMatchObject({
    optionalCapabilities: {
      'lookup@1': {
        kind: 'read',
        input: './schemas/lookup@1.input.json',
        output: './schemas/lookup@1.output.json',
      },
    },
    skills: ['./SKILL.md'],
  });
});

test('sorts maps by code units, preserves field order and never mutates the definition', () => {
  const a: AgentDefinition = {
    ...definition,
    capabilities: { required: { 'z@1': request, 'Z@1': request } },
    models: { z: { modality: 'text' }, Z: { modality: 'text' } },
    ui: { catalog: 'test/v1', components: ['Text'], surfaces: ['main'] },
    skills: ['./SKILL.md'],
  };
  const b: AgentDefinition = {
    ...a,
    capabilities: { required: { 'Z@1': request, 'z@1': request } },
    models: { Z: { modality: 'text' }, z: { modality: 'text' } },
  };
  const first = createManifest(a, options);
  expect(first).toEqual(createManifest(a, options));
  expect(JSON.stringify(first)).toBe(JSON.stringify(createManifest(b, options)));
  expect(Object.keys(first.manifest)).toEqual([
    'schemaVersion',
    'id',
    'version',
    'executor',
    'entry',
    'inputSchema',
    'requiredCapabilities',
    'models',
    'ui',
    'skills',
  ]);
  expect(Object.keys(first.manifest.requiredCapabilities ?? {})).toEqual(['Z@1', 'z@1']);
  expect(Object.keys(first.manifest.models ?? {})).toEqual(['Z', 'z']);
  expect(Object.keys(first.schemas)).toEqual([
    './schemas/Z@1.input.json',
    './schemas/Z@1.output.json',
    './schemas/input.json',
    './schemas/z@1.input.json',
    './schemas/z@1.output.json',
  ]);
  expect(Object.keys(a.capabilities?.required ?? {})).toEqual(['z@1', 'Z@1']);
});

test.each([
  { id: '' },
  { version: '' },
  { executor: '' },
  { id: 1 },
  { version: null },
  { executor: undefined },
  { capabilities: { required: { 'private-value': request } } },
  { capabilities: { optional: { 'private-value@next': request } } },
  { capabilities: { required: { 'lookup@1': request }, optional: { 'lookup@1': request } } },
  { skills: ['private-value'] },
  { skills: ['./../private-value'] },
  { skills: ['./dir\\private-value'] },
  { skills: ['./https:private-value'] },
  { skills: ['./private-value', './private-value'] },
  { skills: ['./dist/index.js'] },
])('rejects invalid definitions with fixed errors', (changes) => {
  try {
    createManifest({ ...definition, ...changes } as unknown as AgentDefinition, options);
    expect.unreachable('Expected invalid definition rejection.');
  } catch (error) {
    expect(error).toBeInstanceOf(GalaxieError);
    expect(error).toMatchObject({ code: 'invalid' });
    expect((error as Error).message).not.toContain('private-value');
    expect(error).not.toHaveProperty('cause');
  }
});

test.each(['private-value', './../private-value', './dir\\private-value', './https:private-value'])(
  'rejects invalid entry paths with fixed errors',
  (entry) => {
    expect(() => createManifest(definition, { entry })).toThrowError(
      new GalaxieError('invalid', 'The manifest path is invalid.'),
    );
  },
);

test.each([z.date(), z.object({ at: z.date().optional() }), z.custom()])(
  'rejects unrepresentable schemas without retaining the schema error',
  (input) => {
    expect(() => createManifest({ ...definition, input }, options)).toThrowError(
      new GalaxieError('unsupported', 'The schema cannot be represented.'),
    );
  },
);

test('rejects schemas without Standard JSON Schema and strips converter errors', () => {
  for (const input of [
    { '~standard': {} },
    {
      '~standard': {
        jsonSchema: {
          input: () => {
            throw new Error('private-value');
          },
        },
      },
    },
  ]) {
    expect(() =>
      createManifest({ ...definition, input } as unknown as AgentDefinition, options),
    ).toThrowError(new GalaxieError('unsupported', 'The schema cannot be represented.'));
  }
});

test('input-side transforms and custom refinements remain representable', () => {
  const result = createManifest(
    {
      ...definition,
      input: z
        .string()
        .refine(() => true)
        .transform(Number),
    },
    options,
  );
  expect(result.schemas['./schemas/input.json']).toMatchObject({ type: 'string' });
});
