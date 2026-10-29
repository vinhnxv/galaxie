// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { OpenAIClient } from '@langchain/openai';
import type { ModelUnavailableReason } from '../errors.js';
import { isLocalEndpoint } from './urls.js';

export type EndpointDestination =
  | 'in-browser'
  | 'user-device'
  | 'user-endpoint'
  | 'host-server'
  | 'third-party';

export function classifyOpenAIError(
  error: unknown,
  endpoint?: { readonly baseURL: string; readonly destination?: EndpointDestination },
):
  | { readonly code: 'unavailable'; readonly reason: ModelUnavailableReason }
  | { readonly code: 'unreachable'; readonly reason?: never }
  | undefined {
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
    if (error instanceof OpenAIClient.APIConnectionError) {
      if (
        endpoint !== undefined &&
        (endpoint.destination === 'user-device' ||
          ((endpoint.destination === undefined || endpoint.destination === 'user-endpoint') &&
            isLocalEndpoint(new URL(endpoint.baseURL))))
      )
        return { code: 'unreachable' };
      return { code: 'unavailable', reason: 'network' };
    }
  }
  return undefined;
}
