// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { type ErrorCode, GalaxieError, isGalaxieError, toErrorInfo } from '@galaxie/core';
import { BridgeValidationError } from './bridge.js';

export function adapterFailure(code: ErrorCode): GalaxieError {
  return new GalaxieError(code, toErrorInfo(code).message);
}
export function failureCode(error: unknown, fallback: ErrorCode = 'executor_error'): ErrorCode {
  if (typeof error === 'object' && error !== null) {
    if ('invalidated' in error && error.invalidated === true) return 'stale';
    if ('fenced' in error && error.fenced === true) return 'fenced';
    if ('unrecoverable' in error && error.unrecoverable === true) return 'unrecoverable';
  }
  return error instanceof BridgeValidationError
    ? error.code
    : isGalaxieError(error)
      ? error.code
      : fallback;
}
