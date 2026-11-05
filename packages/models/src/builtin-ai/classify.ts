// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { ModelUnavailableReason } from '../errors.js';

export type BuiltInAIFailure =
  | { readonly code: 'unavailable'; readonly reason: ModelUnavailableReason }
  | { readonly code: 'invalid' };

/** Only the exception name and operation may cross the browser error boundary. */
export function classifyBuiltInAIError(
  error: unknown,
  step: 'create' | 'prompt',
): BuiltInAIFailure | undefined {
  const name =
    typeof error === 'object' && error !== null && 'name' in error ? error.name : undefined;
  switch (name) {
    case 'NotSupportedError':
      return step === 'create'
        ? { code: 'unavailable', reason: 'unsupported_languages' }
        : { code: 'invalid' };
    case 'QuotaExceededError':
    case 'TypeError':
      return { code: 'invalid' };
    case 'NetworkError':
      return { code: 'unavailable', reason: 'download_failed' };
    case 'NotAllowedError':
      return { code: 'unavailable', reason: 'not_allowed' };
    default:
      return undefined;
  }
}
