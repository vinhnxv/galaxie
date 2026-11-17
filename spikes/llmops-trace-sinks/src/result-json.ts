// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function scalarLike(item: JsonValue): boolean {
  if (item === null || typeof item !== 'object') return true;
  return Array.isArray(item) ? item.length === 0 : Object.keys(item).length === 0;
}

function format(value: JsonValue, depth: number, column: number, last: boolean): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const indent = '  '.repeat(depth);
  const childIndent = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.every(scalarLike)) {
      const inline = `[${value.map((item) => JSON.stringify(item)).join(', ')}]`;
      if (column + inline.length + (last ? 0 : 1) <= 100) return inline;
    }
    return `[\n${value.map((item, index) => `${childIndent}${format(item, depth + 1, childIndent.length, index === value.length - 1)}`).join(',\n')}\n${indent}]`;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return '{}';
  return `{\n${entries
    .map(([key, item], index) => {
      const prefix = `${childIndent}${JSON.stringify(key)}: `;
      return `${prefix}${format(item, depth + 1, prefix.length, index === entries.length - 1)}`;
    })
    .join(',\n')}\n${indent}}`;
}

export function resultJson(value: unknown): string {
  const normalized = JSON.parse(JSON.stringify(value)) as JsonValue;
  return `${format(normalized, 0, 0, true)}\n`;
}
