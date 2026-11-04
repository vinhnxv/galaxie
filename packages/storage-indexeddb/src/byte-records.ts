// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { Envelope } from './envelope.js';
import { StorageError } from './errors.js';
import { validateKey } from './keys.js';

/** Opaque checkpoint operations; bytes are Uint8Array, never bridge base64. */
export interface ByteCheckpointPort {
  request(value: unknown): Promise<unknown>;
}

export interface ByteWrite {
  readonly channel: string;
  readonly index: number;
  readonly value: Envelope;
  readonly interruptIds: readonly string[];
}
type Location = { readonly sessionId: string; readonly namespace: string };
export type ByteExecutor =
  | 'langgraph-python'
  | 'pydantic-ai-python'
  | 'dspy-python'
  | 'adk-js'
  | 'adk-python'
  | 'adk-go';

export function isByteExecutor(value: unknown): value is ByteExecutor {
  return (
    value === 'langgraph-python' ||
    value === 'pydantic-ai-python' ||
    value === 'dspy-python' ||
    value === 'adk-js' ||
    value === 'adk-python' ||
    value === 'adk-go'
  );
}

export type ByteCheckpointRequest = { readonly executor: ByteExecutor } & (
  | { readonly op: 'delete'; readonly sessionId: string }
  | (Location & { readonly op: 'get'; readonly id?: string })
  | {
      readonly op: 'list';
      readonly sessionId: string;
      readonly namespace?: string;
      readonly id?: string;
      readonly before?: string;
      readonly limit?: number;
    }
  | (Location & {
      readonly op: 'put';
      readonly id: string;
      readonly parentId: string | null;
      readonly checkpoint: Envelope;
      readonly metadata: Envelope;
      readonly timestamp: string;
    })
  | (Location & {
      readonly op: 'put-writes';
      readonly id: string;
      readonly taskId: string;
      readonly taskPath: string;
      readonly writes: readonly ByteWrite[];
    })
);

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function fields(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  if (
    !required.every((key) => Object.hasOwn(value, key)) ||
    !Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  )
    throw new StorageError('invalid');
}
function bytes(value: unknown): Envelope {
  if (!object(value)) throw new StorageError('invalid');
  fields(value, ['type', 'bytes']);
  if (
    typeof value['type'] !== 'string' ||
    !value['type'] ||
    !(value['bytes'] instanceof Uint8Array)
  )
    throw new StorageError('invalid');
  return { v: 1, type: value['type'], bytes: value['bytes'].slice() };
}
export function parseByteRequest(request: unknown): ByteCheckpointRequest {
  if (!object(request)) throw new StorageError('invalid');
  // Untagged requests retain the original LangGraph Python port contract.
  const executor = 'executor' in request ? request['executor'] : 'langgraph-python';
  if (!isByteExecutor(executor)) throw new StorageError('invalid');
  const value = { ...request };
  delete value['executor'];
  const op = value['op'];
  const sessionId = value['sessionId'];
  validateKey(sessionId);
  if (op === 'delete') {
    fields(value, ['op', 'sessionId']);
    return { op, sessionId, executor };
  }
  const namespace = value['namespace'];
  if (op === 'list') {
    fields(value, ['op', 'sessionId'], ['namespace', 'id', 'before', 'limit']);
    if (namespace !== undefined) validateKey(namespace, true);
    if (value['id'] !== undefined) validateKey(value['id']);
    if (value['before'] !== undefined) validateKey(value['before']);
    if (
      value['limit'] !== undefined &&
      (typeof value['limit'] !== 'number' ||
        !Number.isSafeInteger(value['limit']) ||
        value['limit'] < 0)
    )
      throw new StorageError('invalid');
    return {
      op,
      executor,
      sessionId,
      ...(namespace === undefined ? {} : { namespace }),
      ...(value['id'] === undefined ? {} : { id: value['id'] as string }),
      ...(value['before'] === undefined ? {} : { before: value['before'] as string }),
      ...(value['limit'] === undefined ? {} : { limit: value['limit'] as number }),
    };
  }
  validateKey(namespace, true);
  const location = { sessionId, namespace, executor };
  if (op === 'get') {
    fields(value, ['op', 'sessionId', 'namespace'], ['id']);
    if (value['id'] !== undefined) validateKey(value['id']);
    return { op, ...location, ...(value['id'] === undefined ? {} : { id: value['id'] as string }) };
  }
  const id = value['id'];
  validateKey(id);
  if (op === 'put') {
    fields(value, [
      'op',
      'sessionId',
      'namespace',
      'id',
      'parentId',
      'checkpoint',
      'metadata',
      'timestamp',
    ]);
    const parentId = value['parentId'];
    if (parentId !== null) validateKey(parentId);
    if (typeof value['timestamp'] !== 'string' || !Number.isFinite(Date.parse(value['timestamp'])))
      throw new StorageError('invalid');
    return {
      op,
      ...location,
      id,
      parentId,
      checkpoint: bytes(value['checkpoint']),
      metadata: bytes(value['metadata']),
      timestamp: value['timestamp'],
    };
  }
  if (op === 'put-writes') {
    fields(value, ['op', 'sessionId', 'namespace', 'id', 'taskId', 'taskPath', 'writes']);
    const taskId = value['taskId'];
    validateKey(taskId);
    if (typeof value['taskPath'] !== 'string' || !Array.isArray(value['writes']))
      throw new StorageError('invalid');
    const writes = value['writes'].map((write: unknown): ByteWrite => {
      if (!object(write)) throw new StorageError('invalid');
      fields(write, ['channel', 'index', 'value', 'interruptIds']);
      if (
        typeof write['channel'] !== 'string' ||
        typeof write['index'] !== 'number' ||
        !Number.isSafeInteger(write['index']) ||
        !Array.isArray(write['interruptIds']) ||
        !write['interruptIds'].every((id: unknown) => typeof id === 'string' && id.length > 0)
      )
        throw new StorageError('invalid');
      if (write['channel'] !== '__interrupt__' && write['interruptIds'].length > 0)
        throw new StorageError('invalid');
      return {
        channel: write['channel'],
        index: write['index'],
        value: bytes(write['value']),
        interruptIds: [...write['interruptIds']] as string[],
      };
    });
    return { op, ...location, id, taskId, taskPath: value['taskPath'], writes };
  }
  throw new StorageError('invalid');
}
