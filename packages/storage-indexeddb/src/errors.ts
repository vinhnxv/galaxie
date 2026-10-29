// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

export type StorageErrorCode =
  | 'invalid'
  | 'corrupt'
  | 'newer_schema'
  | 'superseded'
  | 'blocked'
  | 'quota'
  | 'aborted'
  | 'unavailable';

const messages: Record<StorageErrorCode, string> = {
  invalid: 'The storage request is invalid.',
  corrupt: 'Stored checkpoint data is corrupt.',
  newer_schema: 'The storage schema is newer than this package supports.',
  blocked: 'The storage upgrade is blocked.',
  superseded: 'Another version of the app upgraded the storage.',
  quota: 'The storage quota was exceeded.',
  aborted: 'The storage transaction was aborted.',
  unavailable: 'Checkpoint storage is unavailable.',
};

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  declare readonly unrecoverable: boolean;

  constructor(code: StorageErrorCode) {
    super(messages[code]);
    this.name = 'StorageError';
    this.code = code;
    Object.defineProperty(this, 'unrecoverable', {
      value: code === 'corrupt' || code === 'newer_schema' || code === 'superseded',
      enumerable: true,
    });
  }
}

export function storageError(error: unknown): StorageError {
  if (error instanceof StorageError) return error;
  const name =
    typeof error === 'object' && error !== null && 'name' in error ? error.name : undefined;
  if (name === 'QuotaExceededError') return new StorageError('quota');
  if (name === 'AbortError') return new StorageError('aborted');
  if (name === 'VersionError') return new StorageError('newer_schema');
  return new StorageError('unavailable');
}
