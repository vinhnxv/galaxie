// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}
export interface Fragment {
  readonly layer: string;
  readonly value: JsonObject;
}

export class MergeConflictError extends Error {
  constructor(path: string, first: string, second: string) {
    super(`Merge conflict at ${path} between layers ${first} and ${second}.`);
  }
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isJson(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  return (
    isObject(value) &&
    Object.entries(value).every(
      ([key, child]) => !['__proto__', 'constructor', 'prototype'].includes(key) && isJson(child),
    )
  );
}

export function mergeFragments(
  fragments: readonly Fragment[],
  target = 'package.json',
): JsonObject {
  const result: JsonObject = {};
  const owners = new Map<string, string>();
  const claim = (value: JsonValue, path: string, layer: string): void => {
    owners.set(path, layer);
    if (isObject(value))
      for (const [key, child] of Object.entries(value))
        claim(child, path === '' ? key : `${path}.${key}`, layer);
  };
  const merge = (into: JsonObject, incoming: JsonObject, prefix: string, layer: string): void => {
    for (const [key, value] of Object.entries(incoming)) {
      const path = prefix === '' ? key : `${prefix}.${key}`;
      if (!Object.hasOwn(into, key)) {
        into[key] = structuredClone(value);
        claim(value, path, layer);
        continue;
      }
      const previous = into[key];
      if (isObject(previous) && isObject(value)) merge(previous, value, path, layer);
      else if (
        Array.isArray(previous) &&
        Array.isArray(value) &&
        ['compilerOptions.types', 'include'].includes(path)
      ) {
        if (![...previous, ...value].every((item) => typeof item === 'string'))
          throw new MergeConflictError(`${target}.${path}`, owners.get(path) ?? 'unknown', layer);
        into[key] = [...new Set([...previous, ...value])];
      } else if (!Array.isArray(previous) && !Array.isArray(value) && previous === value) {
      } else
        throw new MergeConflictError(`${target}.${path}`, owners.get(path) ?? 'unknown', layer);
    }
  };
  for (const fragment of fragments) merge(result, fragment.value, '', fragment.layer);
  return result;
}
