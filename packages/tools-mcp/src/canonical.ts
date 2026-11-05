// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { failure } from './events.js';

function invalid(): never {
  throw failure('invalid');
}

function string(value: string): string {
  if (!value.isWellFormed()) invalid();
  return JSON.stringify(value);
}

/** RFC 8785: ECMAScript number serialization and recursive UTF-16 key ordering. */
export function canonical(value: unknown): string {
  const ancestors = new Set<object>();
  const encode = (item: unknown): string => {
    if (item === null) return 'null';
    if (typeof item === 'string') return string(item);
    if (typeof item === 'boolean') return String(item);
    if (typeof item === 'number') return Number.isFinite(item) ? JSON.stringify(item) : invalid();
    if (typeof item !== 'object' || ancestors.has(item)) return invalid();
    ancestors.add(item);
    try {
      if (Array.isArray(item)) return `[${Array.from(item, encode).join(',')}]`;
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)
        return invalid();
      return `{${Object.keys(item)
        .sort()
        .map((key) => `${string(key)}:${encode((item as Record<string, unknown>)[key])}`)
        .join(',')}}`;
    } finally {
      ancestors.delete(item);
    }
  };
  try {
    return encode(value);
  } catch {
    return invalid();
  }
}

/** Hashes only the MCP definition fields the host approves, never runtime results. */
export async function toolPin(
  tool: Pick<
    Tool,
    'name' | 'title' | 'description' | 'inputSchema' | 'outputSchema' | 'annotations'
  >,
): Promise<string> {
  try {
    const definition: Record<string, unknown> = {};
    for (const key of [
      'name',
      'title',
      'description',
      'inputSchema',
      'outputSchema',
      'annotations',
    ] as const) {
      if (tool[key] !== undefined) definition[key] = tool[key];
    }
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(canonical(definition)),
    );
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
      '',
    );
  } catch {
    return invalid();
  }
}
