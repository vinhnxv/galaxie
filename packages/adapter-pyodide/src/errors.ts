// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { storageMarkerCode } from '@galaxie-ai/adapter-kit';
import { type ErrorCode, GalaxieError, isGalaxieError, toErrorInfo } from '@galaxie-ai/core';
import { BridgeValidationError } from './bridge.js';

export function adapterFailure(code: ErrorCode): GalaxieError {
  return new GalaxieError(code, toErrorInfo(code).message);
}
export function failureCode(error: unknown, fallback: ErrorCode = 'executor_error'): ErrorCode {
  const marked = storageMarkerCode(error);
  if (marked !== undefined) return marked;
  return error instanceof BridgeValidationError
    ? error.code
    : isGalaxieError(error)
      ? error.code
      : fallback;
}
