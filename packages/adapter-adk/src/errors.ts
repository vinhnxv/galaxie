// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { type ErrorCode, type ErrorInfo, GalaxieError, toErrorInfo } from '@galaxie/core';

/** A galaxie error with the fixed message of its code; no content or cause text is added. */
export function failure(code: ErrorCode): GalaxieError {
  return new GalaxieError(code, toErrorInfo(code).message);
}

/** The error info for a run result, carrying the original error only as a non-enumerable cause. */
export function adapterError(code: ErrorCode, cause?: unknown): ErrorInfo {
  const info = toErrorInfo(code, cause);
  return Object.assign(new GalaxieError(code, info.message, { cause }), info);
}
