// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { StorageError } from './errors.js';

export type CheckpointKey = [string, string, string, string, string];

export function validateScope(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value))
    throw new StorageError('invalid');
}

export function validateKey(value: unknown, allowEmpty = false): asserts value is string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    ['__proto__', 'constructor', 'prototype'].includes(value)
  )
    throw new StorageError('invalid');
}

/** Object.keys puts canonical array indexes first, then strings in insertion order. */
export function compareObjectKeys(a: string, aOrder: number, b: string, bOrder: number): number {
  const index = (key: string): number | undefined => {
    const value = Number(key);
    return Number.isInteger(value) && value >= 0 && value < 2 ** 32 - 1 && String(value) === key
      ? value
      : undefined;
  };
  const left = index(a);
  const right = index(b);
  if (left !== undefined) return right === undefined ? -1 : left - right;
  return right === undefined ? aOrder - bOrder : 1;
}

export function checkpointKey(
  appId: string,
  principalScope: string,
  threadId: string,
  namespace: string,
  checkpointId: string,
): CheckpointKey {
  return [appId, principalScope, threadId, namespace, checkpointId];
}

/** All stored key suffixes start with strings or numbers, below an array sentinel. */
export function prefixRange(prefix: IDBValidKey[]): IDBKeyRange {
  return IDBKeyRange.bound(prefix, [...prefix, []], false, true);
}
