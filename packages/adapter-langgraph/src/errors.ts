// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { type ErrorCode, type ErrorInfo, GalaxieError, toErrorInfo } from '@galaxie/core';

export function adapterError(code: ErrorCode, cause?: unknown): ErrorInfo {
  const info = toErrorInfo(code, cause);
  return Object.assign(new GalaxieError(code, info.message, { cause }), info);
}
