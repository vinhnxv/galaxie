// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { SerializerProtocol } from '@langchain/langgraph-checkpoint';
import { StorageError, storageError } from './errors.js';

export interface Envelope {
  readonly v: 1;
  readonly type: string;
  readonly bytes: Uint8Array;
}

export async function encode(serde: SerializerProtocol, value: unknown): Promise<Envelope> {
  try {
    const [type, bytes] = await serde.dumpsTyped(value);
    if (typeof type !== 'string' || !(bytes instanceof Uint8Array))
      throw new StorageError('unavailable');
    return { v: 1, type, bytes };
  } catch (error) {
    throw storageError(error);
  }
}

export async function decode(serde: SerializerProtocol, value: unknown): Promise<unknown> {
  try {
    if (
      typeof value !== 'object' ||
      value === null ||
      !('v' in value) ||
      value.v !== 1 ||
      !('type' in value) ||
      typeof value.type !== 'string' ||
      !('bytes' in value) ||
      !(value.bytes instanceof Uint8Array)
    )
      throw new StorageError('corrupt');
    return await serde.loadsTyped(value.type, value.bytes);
  } catch {
    throw new StorageError('corrupt');
  }
}
