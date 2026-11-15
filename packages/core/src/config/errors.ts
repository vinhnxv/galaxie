// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { type ErrorCode, GalaxieError, toErrorInfo } from '../errors.js';

/** Content-free failure with an entry path kept separately from the fixed message. */
export class HostConfigError extends GalaxieError {
  readonly path: string;

  constructor(code: ErrorCode, path: string, cause?: GalaxieError) {
    super(code, toErrorInfo(code).message, cause === undefined ? undefined : { cause });
    this.name = 'HostConfigError';
    this.path = path;
  }
}

export function pointer(parts: readonly PropertyKey[]): string {
  return parts
    .map((part) => `/${String(part).replaceAll('~', '~0').replaceAll('/', '~1')}`)
    .join('');
}
