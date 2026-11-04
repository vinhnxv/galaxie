// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { type ErrorCode, GalaxieError, toErrorInfo } from '@galaxie/core';

export function adapterFailure(code: ErrorCode): GalaxieError {
  return new GalaxieError(code, toErrorInfo(code).message);
}

const CODES: ReadonlySet<string> = new Set<ErrorCode>([
  'invalid',
  'denied',
  'unavailable',
  'unreachable',
  'unsupported',
  'budget_exceeded',
  'timeout',
  'stale',
  'duplicate',
  'fenced',
  'cancelled',
  'unrecoverable',
  'outcome_unknown',
  'executor_error',
]);

/** A code the Go program reported, or `executor_error` when it is not a galaxie error code. */
export function errorCodeOf(value: string): ErrorCode {
  return CODES.has(value) ? (value as ErrorCode) : 'executor_error';
}
