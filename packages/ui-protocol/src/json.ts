// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { JsonObject, JsonValue } from './messages.js';

export function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Define own data properties so even an own __proto__ key is inert. */
export function setOwn(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** No accessor is invoked, and shared subobjects are copied independently. */
export function copyJson(value: unknown): JsonValue {
  const ancestors = new Set<object>();
  const visit = (input: unknown): JsonValue => {
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (typeof input !== 'object' || input === null || ancestors.has(input)) throw new Error();
    const array = Array.isArray(input);
    const prototype: unknown = Object.getPrototypeOf(input);
    if (!array && prototype !== null && prototype !== Object.prototype) throw new Error();
    if (array && prototype !== Array.prototype) throw new Error();
    ancestors.add(input);
    const output: Record<string, JsonValue> | JsonValue[] = array ? [] : {};
    const keys = Reflect.ownKeys(input);
    if (array && keys.length !== input.length + 1) throw new Error();
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') throw new Error();
      if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= input.length)) throw new Error();
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
        throw new Error();
      }
      setOwn(output, key, visit(descriptor.value));
    }
    ancestors.delete(input);
    return output;
  };
  return visit(value);
}

/** UTF-8 JSON size without a platform encoder or a Node dependency. */
export function jsonBytes(value: unknown): number {
  const text = JSON.stringify(value);
  let bytes = 0;
  for (const character of text) {
    const point = character.codePointAt(0) ?? 0;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}

export function pointerParts(path: string, relative = false): string[] | undefined {
  if (path === '') return [];
  if (!path.startsWith('/') && !relative) return undefined;
  const parts = (path.startsWith('/') ? path.slice(1) : path).split('/');
  if (parts.some((part) => /~(?:[^01]|$)/.test(part))) return undefined;
  return parts.map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
}

export function arrayIndex(key: string, length: number): number | undefined {
  if (!/^(0|[1-9]\d*)$/.test(key)) return undefined;
  const index = Number(key);
  return Number.isSafeInteger(index) && index < length ? index : undefined;
}

export function resolvePath(root: JsonValue, parts: readonly string[]): JsonValue | undefined {
  let current = root;
  for (const part of parts) {
    if (Array.isArray(current)) {
      const index = arrayIndex(part, current.length);
      if (index === undefined) return undefined;
      current = current[index] as JsonValue;
    } else if (isObject(current) && Object.hasOwn(current, part)) {
      current = current[part] as JsonValue;
    } else return undefined;
  }
  return current;
}

/** RFC 6901 lookup; relative paths are confined to the supplied template item. */
export function resolveDataPath(
  path: string,
  model: JsonObject,
  item?: JsonValue,
): JsonValue | undefined {
  const absolute = path === '' || path.startsWith('/');
  const parts = pointerParts(path, !absolute && item !== undefined);
  if (parts === undefined || (!absolute && item === undefined)) return undefined;
  return resolvePath(absolute ? model : (item as JsonValue), parts);
}
