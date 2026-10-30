// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import {
  type ByteCheckpointRequest,
  parseByteRequest,
} from '../../../packages/storage-indexeddb/src/byte-records.js';

type Put = Extract<ByteCheckpointRequest, { op: 'put' }>;
type Write = {
  taskId: string;
  taskPath: string;
  index: number;
  channel: string;
  value: { type: string; bytes: Uint8Array };
};
/** Test-only byte storage for Node, where IndexedDB is absent. */
export class MemoryByteCheckpoints {
  readonly rows: Map<string, Put> = new Map();
  readonly writes: Map<string, Write[]> = new Map();
  async request(value: unknown): Promise<unknown> {
    const input = parseByteRequest(value);
    if (input.op === 'delete') throw new Error('Unexpected thread deletion.');
    const key = (id: string): string => JSON.stringify([input.sessionId, input.namespace, id]);
    if (input.op === 'put') {
      this.rows.set(key(input.id), structuredClone(input));
      return null;
    }
    if (input.op === 'put-writes') {
      const writes = this.writes.get(key(input.id)) ?? [];
      for (const write of input.writes) {
        const index = writes.findIndex(
          (row) => row.taskId === input.taskId && row.index === write.index,
        );
        if (index >= 0 && write.index >= 0) continue;
        const row = {
          taskId: input.taskId,
          taskPath: input.taskPath,
          index: write.index,
          channel: write.channel,
          value: { type: write.value.type, bytes: write.value.bytes },
        };
        if (index >= 0) writes[index] = row;
        else writes.push(row);
      }
      this.writes.set(key(input.id), writes);
      return null;
    }
    const rows = [...this.rows.values()]
      .filter(
        (row) =>
          row.sessionId === input.sessionId &&
          (input.namespace === undefined || row.namespace === input.namespace) &&
          (!input.id || row.id === input.id) &&
          (input.op !== 'list' || !input.before || row.id < input.before),
      )
      .sort((a, b) => b.id.localeCompare(a.id));
    const tuples = rows.slice(0, input.op === 'get' ? 1 : input.limit).map((row) => ({
      sessionId: row.sessionId,
      namespace: row.namespace,
      id: row.id,
      parentId: row.parentId,
      checkpoint: { type: row.checkpoint.type, bytes: row.checkpoint.bytes },
      metadata: { type: row.metadata.type, bytes: row.metadata.bytes },
      writes: this.writes.get(key(row.id)) ?? [],
      parentWrites: row.parentId === null ? [] : (this.writes.get(key(row.parentId)) ?? []),
    }));
    return structuredClone(input.op === 'get' ? (tuples[0] ?? null) : tuples);
  }
}
