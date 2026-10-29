// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { StorageError } from './errors.js';

export type CheckpointKey = [string, string, string, string, string];

export function validateScope(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value))
    throw new StorageError('invalid');
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
