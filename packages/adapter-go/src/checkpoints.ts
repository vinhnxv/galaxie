// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { storageMarkerCode } from '@galaxie-ai/adapter-kit';
import { type ErrorCode, isGalaxieError } from '@galaxie-ai/core';
import type { ConversationRecord } from './bridge.js';
import { adapterFailure } from './errors.js';
import {
  decodeStored,
  encodeStored,
  revisionId,
  SESSION_TYPE,
  STATE_TYPE,
  type StoredConversation,
} from './persist.js';
import { GO_EXECUTOR_ID as EXECUTOR } from './protocol.js';

export interface CheckpointPort {
  request(value: unknown): Promise<unknown>;
}

export function validCheckpointPort(value: unknown): value is CheckpointPort {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { request?: unknown }).request === 'function'
  );
}

/** Storage reports why a write or read was refused through marker fields; keep that reason. */
function storageCode(error: unknown): ErrorCode {
  return storageMarkerCode(error) ?? 'unavailable';
}

function unavailable(error: unknown): never {
  throw isGalaxieError(error) ? error : adapterFailure(storageCode(error));
}

export async function loadConversation(
  port: CheckpointPort,
  sessionId: string,
): Promise<StoredConversation | undefined> {
  let reply: unknown;
  try {
    reply = await port.request({ op: 'get', executor: EXECUTOR, sessionId, namespace: '' });
  } catch (error) {
    return unavailable(error);
  }
  if (reply === null) return undefined;
  const value = reply as Record<string, unknown> | undefined;
  if (
    typeof value !== 'object' ||
    value === null ||
    value['sessionId'] !== sessionId ||
    value['namespace'] !== '' ||
    typeof value['checkpoint'] !== 'object' ||
    value['checkpoint'] === null ||
    typeof value['metadata'] !== 'object' ||
    value['metadata'] === null
  )
    throw adapterFailure('unrecoverable');
  return decodeStored(sessionId, {
    id: value['id'],
    checkpoint: value['checkpoint'] as { type: unknown; bytes: unknown },
    metadata: value['metadata'] as { type: unknown; bytes: unknown },
  });
}

/**
 * Writes a conversation as the next revision: a marker first, then the checkpoint that commits it.
 * An orphan marker from a failed save is replaced by the next attempt. Returns the new revision.
 */
export async function saveConversation(
  port: CheckpointPort,
  sessionId: string,
  previous: number,
  key: Uint8Array,
  record: ConversationRecord,
  position: number,
  pendingId: string | undefined,
): Promise<number> {
  const { checkpoint, metadata } = await encodeStored(sessionId, record, position, key);
  const location = { executor: EXECUTOR, sessionId, namespace: '', id: revisionId(previous + 1) };
  try {
    await port.request({
      op: 'put-writes',
      ...location,
      taskId: 'conversation',
      taskPath: '',
      writes: [
        {
          channel: '__interrupt__',
          index: -3,
          interruptIds: pendingId === undefined ? [] : [pendingId],
          value: {
            type: 'json',
            bytes: new TextEncoder().encode(
              JSON.stringify(pendingId === undefined ? null : { id: pendingId }),
            ),
          },
        },
      ],
    });
    await port.request({
      op: 'put',
      ...location,
      parentId: previous > 0 ? revisionId(previous) : null,
      checkpoint: { type: SESSION_TYPE, bytes: checkpoint },
      metadata: { type: STATE_TYPE, bytes: metadata },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return unavailable(error);
  }
  return previous + 1;
}
