// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { type ErrorCode, type ErrorInfo, GalaxieError, toErrorInfo } from '@galaxie/core';

/** Core journals a fresh ErrorInfo and exposes the standard cause only to host diagnostics. */
export function adapterError(code: ErrorCode, cause?: unknown): ErrorInfo {
  const info = toErrorInfo(code, cause);
  return Object.assign(new GalaxieError(code, info.message, { cause }), info);
}
