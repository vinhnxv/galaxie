// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { type ErrorCode, GalaxieError, isGalaxieError, toErrorInfo } from '@galaxie/core';
import { BridgeValidationError } from './bridge.js';

export function adapterFailure(code: ErrorCode): GalaxieError {
  return new GalaxieError(code, toErrorInfo(code).message);
}
export function failureCode(error: unknown, fallback: ErrorCode = 'executor_error'): ErrorCode {
  return error instanceof BridgeValidationError
    ? error.code
    : isGalaxieError(error)
      ? error.code
      : fallback;
}
