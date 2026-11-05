// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

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

export function errorCodeOf(value: string): ErrorCode {
  return CODES.has(value) ? (value as ErrorCode) : 'executor_error';
}
