// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { type JsonObject, type JsonValue, resolveDataPath } from '@galaxie/ui-protocol';

export function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Missing bindings omit the property; the registered schema decides whether it is required. */
export function resolveBindings(
  value: JsonValue,
  model: JsonObject,
  item?: JsonValue,
  declaration = false,
): JsonValue | undefined {
  if (Array.isArray(value))
    return value.map((child) => resolveBindings(child, model, item, declaration) ?? null);
  if (!object(value)) return value;
  if (Object.hasOwn(value, '@call') || Object.hasOwn(value, 'functionCall')) throw new Error();
  if (Object.hasOwn(value, '@path')) {
    if (Object.keys(value).length !== 1 || typeof value['@path'] !== 'string') throw new Error();
    if (
      declaration &&
      item === undefined &&
      value['@path'] !== '' &&
      !value['@path'].startsWith('/')
    )
      return value;
    return resolveDataPath(value['@path'], model, item);
  }
  if (Object.keys(value).some((key) => key.startsWith('@'))) throw new Error();
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) => {
      const resolved = resolveBindings(child, model, item, declaration);
      return resolved === undefined ? [] : [[key, resolved]];
    }),
  );
}

export function hasBinding(value: JsonValue): boolean {
  if (Array.isArray(value)) return value.some(hasBinding);
  return object(value) && (Object.hasOwn(value, '@path') || Object.values(value).some(hasBinding));
}
