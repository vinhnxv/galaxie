// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { failure } from './errors.js';

type JsonObject = Record<string, unknown>;

const TYPES: Readonly<Record<string, string>> = {
  OBJECT: 'object',
  STRING: 'string',
  NUMBER: 'number',
  INTEGER: 'integer',
  BOOLEAN: 'boolean',
  ARRAY: 'array',
  NULL: 'null',
};
// Gemini carries 64-bit limits as decimal strings; JSON Schema wants numbers.
const NUMERIC_LIMITS = [
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minProperties',
  'maxProperties',
] as const;
const COPIED = ['description', 'title', 'format', 'pattern', 'enum', 'default'] as const;
const DEPTH_LIMIT = 32;

function object(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function convert(schema: unknown, depth: number): JsonObject {
  if (!object(schema) || depth > DEPTH_LIMIT) throw failure('invalid');
  const result: JsonObject = {};
  for (const key of COPIED) if (schema[key] !== undefined) result[key] = schema[key];
  // Gemini marks string enums with a format that JSON Schema does not define.
  if (result['format'] === 'enum') delete result['format'];
  for (const key of NUMERIC_LIMITS) {
    const limit = schema[key];
    if (limit === undefined) continue;
    const number = typeof limit === 'string' ? Number(limit) : limit;
    if (typeof number !== 'number' || !Number.isFinite(number)) throw failure('invalid');
    result[key] = number;
  }
  const type = schema['type'];
  if (type !== undefined) {
    if (typeof type !== 'string') throw failure('invalid');
    const lower = TYPES[type.toUpperCase()];
    if (lower === undefined) throw failure('invalid');
    result['type'] = lower;
  }
  if (schema['properties'] !== undefined) {
    const properties = schema['properties'];
    if (!object(properties)) throw failure('invalid');
    result['properties'] = Object.fromEntries(
      Object.entries(properties).map(([name, property]) => [name, convert(property, depth + 1)]),
    );
  }
  if (schema['required'] !== undefined) {
    const required = schema['required'];
    if (!Array.isArray(required) || !required.every((name) => typeof name === 'string'))
      throw failure('invalid');
    result['required'] = required;
  }
  if (schema['items'] !== undefined) result['items'] = convert(schema['items'], depth + 1);
  if (schema['anyOf'] !== undefined) {
    const variants = schema['anyOf'];
    if (!Array.isArray(variants)) throw failure('invalid');
    result['anyOf'] = variants.map((variant) => convert(variant, depth + 1));
  }
  if (schema['nullable'] === true) return { anyOf: [result, { type: 'null' }] };
  return result;
}

/**
 * One function declaration as a JSON Schema object for the provider. `parametersJsonSchema` is
 * already JSON Schema and is used as given; the Gemini `parameters` form is converted.
 */
export function declarationParameters(declaration: {
  readonly parameters?: unknown;
  readonly parametersJsonSchema?: unknown;
}): JsonObject {
  if (declaration.parametersJsonSchema !== undefined) {
    if (!object(declaration.parametersJsonSchema)) throw failure('invalid');
    return declaration.parametersJsonSchema;
  }
  if (declaration.parameters === undefined) return { type: 'object', properties: {} };
  return convert(declaration.parameters, 0);
}

/** A Gemini-style response schema (or JSON Schema) as the JSON Schema the provider enforces. */
export function responseJsonSchema(config: {
  readonly responseSchema?: unknown;
  readonly responseJsonSchema?: unknown;
}): JsonObject | undefined {
  if (config.responseJsonSchema !== undefined) {
    if (!object(config.responseJsonSchema)) throw failure('invalid');
    return config.responseJsonSchema;
  }
  if (config.responseSchema === undefined) return undefined;
  return convert(config.responseSchema, 0);
}
