// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { type ErrorCode, GalaxieError, toErrorInfo } from '@galaxie/core';

export function adapterFailure(code: ErrorCode): GalaxieError {
  return new GalaxieError(code, toErrorInfo(code).message);
}
