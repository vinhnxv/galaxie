// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { ErrorCode } from '@galaxie-ai/core';

const markers = [
  ['invalidated', 'stale'],
  ['fenced', 'fenced'],
  ['unrecoverable', 'unrecoverable'],
] as const;

/**
 * The error code for a storage failure marker, if the error carries one. Only an own data property
 * set to `true` counts, as in core: an inherited marker or an accessor is ignored, so an unusual
 * error object cannot pick the failure code.
 */
export function storageMarkerCode(error: unknown): ErrorCode | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  for (const [marker, code] of markers)
    if (Object.getOwnPropertyDescriptor(error, marker)?.value === true) return code;
  return undefined;
}
