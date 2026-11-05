// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { ByteExecutor } from './byte-records.js';
import type { StoredSession } from './recovery.js';

export type SessionExportValue =
  | null
  | boolean
  | number
  | string
  | readonly SessionExportValue[]
  | { readonly [key: string]: SessionExportValue };

export interface SessionExport {
  readonly format: 'galaxie.session-export/1';
  readonly appId: string;
  readonly sessionId: string;
  readonly exportedAt: string;
  readonly personalContent: boolean;
  readonly metadata: {
    readonly agent: Readonly<StoredSession> | null;
    readonly checkpointCount: number;
    readonly firstTimestamp: string | null;
    readonly lastTimestamp: string | null;
    readonly pendingInteractionCount: number;
    readonly recovery: {
      readonly submissions: Readonly<{ count: number; accepted: number; consumed: number }>;
      readonly effects: Readonly<{
        count: number;
        planned: number;
        dispatched: number;
        succeeded: number;
        failed: number;
        outcome_unknown: number;
      }>;
    };
    readonly unrecoverable?: true;
  };
  readonly checkpoints?: readonly {
    readonly executor?: ByteExecutor;
    readonly id: string;
    readonly parentId: string | null;
    readonly namespace: string;
    readonly timestamp: string | null;
    readonly channelValues: SessionExportValue;
    readonly pendingWrites: readonly (readonly [string, string, SessionExportValue])[];
  }[];
}

export const unavailableValue = '[unavailable]';

export function exportValue(
  value: unknown,
  ancestors: Set<object> = new Set(),
): SessionExportValue {
  try {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : unavailableValue;
    if (typeof value !== 'object' || value instanceof Error || ancestors.has(value))
      return unavailableValue;
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      const bytes =
        value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return Object.freeze({ type: 'base64', data: btoa(binary) });
    }
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Map || value instanceof Set) return unavailableValue;
    ancestors.add(value);
    try {
      if (Array.isArray(value))
        return Object.freeze(
          Array.from({ length: value.length }, (_, index) => {
            const field = Object.getOwnPropertyDescriptor(value, String(index));
            return field && 'value' in field
              ? exportValue(field.value, ancestors)
              : unavailableValue;
          }),
        );
      return Object.freeze(
        Object.fromEntries(
          Object.keys(value).map((key) => {
            const field = Object.getOwnPropertyDescriptor(value, key);
            return [
              key,
              field && 'value' in field ? exportValue(field.value, ancestors) : unavailableValue,
            ];
          }),
        ),
      );
    } finally {
      ancestors.delete(value);
    }
  } catch {
    return unavailableValue;
  }
}

export function exportTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
