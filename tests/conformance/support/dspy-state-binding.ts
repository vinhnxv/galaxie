// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import type { MemoryByteCheckpoints } from './memory-byte-checkpoints.js';

export function stripBinding(rows: MemoryByteCheckpoints['rows']): void {
  for (const [key, row] of rows) {
    const metadata = JSON.parse(new TextDecoder().decode(row.metadata.bytes));
    delete metadata.stateBinding;
    rows.set(key, {
      ...row,
      metadata: { ...row.metadata, bytes: new TextEncoder().encode(JSON.stringify(metadata)) },
    });
  }
}

export function readBinding(rows: MemoryByteCheckpoints['rows']): string | undefined {
  const row = [...rows.values()].at(-1);
  if (!row) throw new Error('The paused checkpoint is missing.');
  return JSON.parse(new TextDecoder().decode(row.metadata.bytes)).stateBinding;
}

/** Independent manifest oracle; UTF-8 ordering matches Unicode code point ordering. */
export function expectedBinding(files: Record<string, string>): string | undefined {
  const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
  const entries = Object.entries(files)
    .filter(([name]) => name.endsWith('.json') && !name.split('/').includes('__pycache__'))
    .sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
    .map(([name, content]) => [name, hash(content)]);
  return entries.length ? hash(JSON.stringify(entries)) : undefined;
}
