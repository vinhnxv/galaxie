// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

/** Go requires enumerable required keys; Pyodide requires own keys. */
export function hasOnlyKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
  enumerableRequired = false,
): boolean {
  if (enumerableRequired) {
    const names = Object.keys(value);
    return (
      required.every((key) => names.includes(key)) &&
      names.every((key) => required.includes(key) || optional.includes(key))
    );
  }
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}

export interface JsonValueChecks {
  readonly plainObjects: boolean;
  readonly maxDepth: number;
  /** Pyodide checks enumerable array properties too; Go checks array elements. */
  readonly arrayProperties: boolean;
}

const plainJson: JsonValueChecks = {
  plainObjects: true,
  maxDepth: Number.POSITIVE_INFINITY,
  arrayProperties: true,
};

export function isJsonValue(
  value: unknown,
  checks: JsonValueChecks = plainJson,
  ancestors: Set<object> = new Set(),
  depth = 0,
): boolean {
  if (depth > checks.maxDepth) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  if (checks.plainObjects && !Array.isArray(value) && !isPlainObject(value)) return false;
  ancestors.add(value);
  const children = Array.isArray(value) && !checks.arrayProperties ? value : Object.values(value);
  const valid = children.every((entry) => isJsonValue(entry, checks, ancestors, depth + 1));
  ancestors.delete(value);
  return valid;
}

export function nonemptyText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function validBridgeToolCall(
  value: unknown,
  name: (value: unknown) => boolean = nonemptyText,
  id?: (value: unknown) => boolean,
  enumerableRequired = false,
): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['id', 'type', 'function'], [], enumerableRequired) &&
    (id === undefined
      ? nonemptyText(value['id']) && (value['id'] as string).length <= 128
      : id(value['id'])) &&
    value['type'] === 'function' &&
    isRecord(value['function']) &&
    hasOnlyKeys(value['function'], ['name', 'arguments'], [], enumerableRequired) &&
    name(value['function']['name']) &&
    typeof value['function']['arguments'] === 'string'
  );
}

export function validChatMessage(
  value: unknown,
  call: (value: unknown) => boolean,
  id: (value: unknown) => boolean = nonemptyText,
  enumerableRequired = false,
): boolean {
  if (!isRecord(value) || typeof value['content'] !== 'string') return false;
  if (value['role'] === 'tool')
    return (
      hasOnlyKeys(value, ['role', 'content', 'tool_call_id'], [], enumerableRequired) &&
      id(value['tool_call_id'])
    );
  if (value['role'] === 'assistant')
    return (
      hasOnlyKeys(value, ['role', 'content'], ['toolCalls'], enumerableRequired) &&
      (value['toolCalls'] === undefined ||
        (Array.isArray(value['toolCalls']) && value['toolCalls'].every((item) => call(item))))
    );
  return (
    ['system', 'user'].includes(value['role'] as string) &&
    hasOnlyKeys(value, ['role', 'content'], [], enumerableRequired)
  );
}

/** Shared option values; adapters keep their closed key sets and validation order. */
export function validModelOption(
  key: 'stop' | 'stream' | 'tools' | 'jsonSchema',
  value: unknown,
  validate: (value: unknown) => boolean = isJsonValue,
): boolean {
  if (value === undefined) return true;
  switch (key) {
    case 'stop':
      return Array.isArray(value) && value.every((item) => typeof item === 'string');
    case 'stream':
      return typeof value === 'boolean';
    case 'tools':
      return Array.isArray(value) && value.every((item) => validate(item));
    case 'jsonSchema':
      return isRecord(value) && validate(value);
  }
}

export interface ToolDefinitionChecks {
  readonly name: (value: unknown) => boolean;
  readonly json: (value: unknown) => boolean;
  readonly strict: boolean;
  readonly descriptionFirst: boolean;
  /** Go requires enumerable required keys; Pyodide requires own keys. */
  readonly enumerableRequired: boolean;
}

const toolDefinitionChecks: ToolDefinitionChecks = {
  name: nonemptyText,
  json: isJsonValue,
  strict: true,
  descriptionFirst: false,
  enumerableRequired: false,
};

/** Keep the two existing tool schemas and their field-check order. */
export function validBridgeTool(
  value: unknown,
  checks: ToolDefinitionChecks = toolDefinitionChecks,
): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['type', 'function'], [], checks.enumerableRequired) &&
    value['type'] === 'function' &&
    isRecord(value['function']) &&
    hasOnlyKeys(
      value['function'],
      ['name', 'parameters'],
      checks.strict ? ['description', 'strict'] : ['description'],
      checks.enumerableRequired,
    ) &&
    checks.name(value['function']['name']) &&
    (!checks.descriptionFirst ||
      value['function']['description'] === undefined ||
      typeof value['function']['description'] === 'string') &&
    isRecord(value['function']['parameters']) &&
    checks.json(value['function']['parameters']) &&
    (checks.descriptionFirst ||
      value['function']['description'] === undefined ||
      typeof value['function']['description'] === 'string') &&
    (!checks.strict ||
      value['function']['strict'] === undefined ||
      typeof value['function']['strict'] === 'boolean')
  );
}

/** Each protocol retains its closed keys, extra fields and input shape. */
export function validCapabilityRequest(
  value: Record<string, unknown>,
  json: (value: unknown) => boolean = isJsonValue,
  recordOnly = false,
): boolean {
  return (
    nonemptyText(value['name']) && (!recordOnly || isRecord(value['input'])) && json(value['input'])
  );
}
