// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { GalaxieError } from './errors.js';
import type { ArgumentShape, DataLabel } from './policy.js';
import type { StandardSchema } from './schema.js';

type Node = Record<string, unknown>;
const LABELS: readonly string[] = ['public', 'app', 'private-user'];
const SHAPES: readonly string[] = ['enum', 'id', 'pattern', 'freeText'];
const ALLOWED = new Set([
  '$schema',
  '$id',
  '$defs',
  '$ref',
  'type',
  'properties',
  'additionalProperties',
  'propertyNames',
  'items',
  'prefixItems',
  'anyOf',
  'oneOf',
  'allOf',
  'not',
  'title',
  'description',
  'default',
  'examples',
  'deprecated',
  'readOnly',
  'writeOnly',
  'format',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'required',
  'enum',
  'const',
  'contentEncoding',
  'contentMediaType',
  'x-galaxie',
]);

function node(value: unknown): Node {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Node)
    : {};
}
function children(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function resolve(value: unknown, root: Node): Node {
  const current = node(value);
  if (current['$ref'] === undefined) return current;
  if (current['$ref'] === '#') return root;
  if (typeof current['$ref'] !== 'string' || !/^#\/\$defs\/[^/]+$/.test(current['$ref']))
    throw new GalaxieError('unsupported', 'The schema reference is unsupported.');
  const key = current['$ref'].slice(8).replace(/~1/g, '/').replace(/~0/g, '~');
  const definitions = node(root['$defs']);
  if (!Object.hasOwn(definitions, key))
    throw new GalaxieError('unsupported', 'The schema reference is unsupported.');
  return node(definitions[key]);
}
function narrow(pattern: unknown): boolean {
  if (typeof pattern !== 'string') return false;
  // Consume escaped pairs first so an escaped backslash cannot hide a wildcard.
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '\\') {
      if (['s', 'S', 'W', 'D'].includes(pattern[++i] ?? '')) return false;
    } else if (char === '.' || char === ' ' || (char === '[' && pattern[i + 1] === '^'))
      return false;
  }
  try {
    return !['a b', 'A B', '0 1', 'a\nb', 'a\tb'].some((value) =>
      new RegExp(pattern, 'u').test(value),
    );
  } catch {
    return false;
  }
}
function shape(current: Node): ArgumentShape {
  if (Array.isArray(current['enum']) || Object.hasOwn(current, 'const')) return 'enum';
  if (current['format'] === 'uuid') return 'id';
  if (narrow(current['pattern']) && typeof current['maxLength'] === 'number') {
    if (current['maxLength'] <= 128) return 'id';
    if (current['maxLength'] <= 256) return 'pattern';
  }
  return 'freeText';
}
function labelsAt(current: Node, inherited: ReadonlySet<DataLabel>): Set<DataLabel> {
  const annotation = node(current['x-galaxie']);
  const result = new Set(inherited);
  if (annotation['label'] !== undefined) {
    if (!LABELS.includes(String(annotation['label'])))
      throw new GalaxieError('invalid', 'The schema label is invalid.');
    result.add(annotation['label'] as DataLabel);
  }
  return result;
}

export interface Annotations {
  readonly labels: ReadonlySet<DataLabel>;
  /** Output-direction shapes of top-level fields; non-string structured fields have no shape. */
  readonly properties: ReadonlyMap<string, ArgumentShape | undefined>;
  privateStrings(value: unknown): string[];
  freeTextStrings(value: unknown): string[];
}

/** Reads Standard JSON Schema in both directions, without importing the schema library. */
export function readAnnotations(schema: StandardSchema): Annotations {
  const standard = schema['~standard'] as unknown as {
    jsonSchema?: {
      input(options: unknown): unknown;
      output(options: unknown): unknown;
    };
  };
  if (
    typeof standard.jsonSchema?.input !== 'function' ||
    typeof standard.jsonSchema.output !== 'function'
  )
    throw new GalaxieError('unsupported', 'The schema must expose Standard JSON Schema.');
  const options = { target: 'draft-2020-12', libraryOptions: { unrepresentable: 'any' } };
  let roots: Node[];
  try {
    roots = [node(standard.jsonSchema.input(options)), node(standard.jsonSchema.output(options))];
  } catch {
    throw new GalaxieError('unsupported', 'The schema cannot be represented.');
  }
  const labels = new Set<DataLabel>();
  const properties = new Map<string, ArgumentShape | undefined>();
  for (const root of roots) {
    const visited = new Map<Node, Set<string>>();
    const inspect = (raw: unknown, inherited: ReadonlySet<DataLabel>): void => {
      if (raw === false) return;
      const original = node(raw);
      for (const key of Object.keys(original)) {
        if (!ALLOWED.has(key) || (key === 'not' && Object.keys(node(original['not'])).length !== 0))
          throw new GalaxieError('unsupported', 'The schema uses an unsupported keyword.');
      }
      const current = resolve(raw, root);
      const own = labelsAt(original, inherited);
      const active = labelsAt(current, own);
      const signature = [...active].sort().join(',');
      const signatures = visited.get(current) ?? new Set<string>();
      if (signatures.has(signature)) return;
      signatures.add(signature);
      visited.set(current, signatures);
      const annotation = node(current['x-galaxie']);
      if (
        annotation['shape'] !== undefined &&
        (!SHAPES.includes(String(annotation['shape'])) ||
          SHAPES.indexOf(String(annotation['shape'])) < SHAPES.indexOf(shape(current)))
      )
        throw new GalaxieError('invalid', 'The declared argument shape exceeds its constraints.');
      for (const label of active) labels.add(label);
      const branches = ['anyOf', 'oneOf', 'allOf'].flatMap((key) => children(current[key]));
      const fields = Object.values(node(current['properties']));
      const positions = [...branches, ...fields, ...children(current['prefixItems'])];
      if (current['items'] !== undefined) positions.push(current['items']);
      if (
        current['additionalProperties'] !== undefined &&
        current['additionalProperties'] !== false
      ) {
        positions.push(current['additionalProperties'], current['propertyNames'] ?? {});
      }
      if (positions.length === 0) {
        if (active.size === 0) labels.add('app');
      } else for (const position of positions) inspect(position, active);
      // Definitions can carry a referenced subtree; resolving references traverses it at its position.
      for (const definition of Object.values(node(current['$defs']))) inspect(definition, active);
    };
    inspect(root, new Set());
  }
  const outputRoot = roots[1] ?? {};
  const addProperties = (raw: unknown, visited: Set<Node>): void => {
    const current = resolve(raw, outputRoot);
    if (visited.has(current)) return;
    visited.add(current);
    for (const [key, rawField] of Object.entries(node(current['properties']))) {
      const field = resolve(rawField, outputRoot);
      properties.set(
        key,
        field['type'] !== undefined && field['type'] !== 'string' ? undefined : shape(field),
      );
    }
    for (const key of ['anyOf', 'oneOf', 'allOf'])
      for (const branch of children(current[key])) addProperties(branch, visited);
  };
  addProperties(outputRoot, new Set());

  const match = (value: unknown, root: Node, mode: 'private' | 'free'): string[] => {
    const result = new Set<string>();
    const seen = new Map<Node, Set<unknown>>();
    const collect = (value: unknown): void => {
      if (typeof value === 'string') result.add(value);
      else if (Array.isArray(value)) for (const child of value) collect(child);
      else if (typeof value === 'object' && value !== null)
        for (const [key, child] of Object.entries(value)) {
          result.add(key);
          collect(child);
        }
    };
    const walk = (value: unknown, raw: unknown, inherited: ReadonlySet<DataLabel>): void => {
      if (raw === false) return;
      const original = node(raw);
      const current = resolve(raw, root);
      const active = labelsAt(current, labelsAt(original, inherited));
      if (mode === 'private' && active.has('private-user')) {
        collect(value);
        return;
      }
      const values = seen.get(current) ?? new Set<unknown>();
      if (values.has(value)) return;
      values.add(value);
      seen.set(current, values);
      const branches = ['anyOf', 'oneOf', 'allOf'].flatMap((key) => children(current[key]));
      for (const branch of branches) walk(value, branch, active);
      if (
        typeof value === 'string' &&
        mode === 'free' &&
        branches.length === 0 &&
        shape(current) === 'freeText'
      )
        result.add(value);
      else if (Array.isArray(value)) {
        for (const [i, item] of value.entries())
          walk(item, children(current['prefixItems'])[i] ?? current['items'] ?? {}, active);
      } else if (typeof value === 'object' && value !== null) {
        const fields = node(current['properties']);
        for (const [key, child] of Object.entries(value)) {
          const known = Object.hasOwn(fields, key);
          if (!known) {
            if (mode === 'free' && shape(resolve(current['propertyNames'], root)) === 'freeText')
              result.add(key);
            if (
              mode === 'private' &&
              labelsAt(node(current['propertyNames']), active).has('private-user')
            )
              result.add(key);
          }
          walk(child, known ? fields[key] : (current['additionalProperties'] ?? {}), active);
        }
      }
    };
    walk(value, root, new Set());
    return [...result];
  };
  return {
    labels,
    properties,
    privateStrings: (value) => [...new Set(roots.flatMap((root) => match(value, root, 'private')))],
    freeTextStrings: (value) => match(value, outputRoot, 'free'),
  };
}
