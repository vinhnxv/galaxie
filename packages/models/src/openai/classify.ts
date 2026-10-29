// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { OpenAIClient } from '@langchain/openai';
import type { ModelUnavailableReason } from '../errors.js';

/** Endpoint failures cross the boundary only as allowlisted codes. */
export function classifyOpenAIError(
  error: unknown,
): { readonly code: 'unavailable'; readonly reason: ModelUnavailableReason } | undefined {
  const status =
    typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined;
  if (status === 401 || status === 403) return { code: 'unavailable', reason: 'not_allowed' };
  if (status === 429) return { code: 'unavailable', reason: 'rate_limited' };
  if (status === 408 || (typeof status === 'number' && status >= 500 && status <= 599))
    return { code: 'unavailable', reason: 'endpoint_failed' };
  if (status === undefined) {
    if (
      error instanceof OpenAIClient.APIConnectionTimeoutError ||
      (error instanceof Error && error.name === 'TimeoutError')
    )
      return { code: 'unavailable', reason: 'endpoint_failed' };
    if (error instanceof OpenAIClient.APIConnectionError)
      return { code: 'unavailable', reason: 'network' };
  }
  return undefined;
}
