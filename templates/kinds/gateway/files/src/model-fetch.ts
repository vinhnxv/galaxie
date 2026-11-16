// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { type GatewayState, gatewayStateForStatus } from './gateway-state.js';

/** The gateway owns the system prompt; only host-owned metadata selects it. */
export function createModelFetch(
  fetcher: typeof globalThis.fetch,
  publish: (state: GatewayState) => void,
): typeof globalThis.fetch {
  return async (input, init) => {
    try {
      const request = new Request(input, init);
      const payload = (await request.json()) as Record<string, unknown>;
      const response = await fetcher(request.url, {
        method: request.method,
        headers: request.headers,
        signal: request.signal,
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        body: JSON.stringify({
          ...payload,
          ...(Array.isArray(payload['messages'])
            ? {
                messages: payload['messages'].filter((message: unknown) => {
                  if (typeof message !== 'object' || message === null) return true;
                  const role = (message as Record<string, unknown>)['role'];
                  return role !== 'system' && role !== 'developer';
                }),
              }
            : {}),
          metadata: { promptId: 'practice-comment', variables: { tone: 'encouraging' } },
        }),
      });
      const mock = response.ok && response.headers.get('x-galaxie-upstream') === 'mock';
      // Finish the fixed mock body before the SDK cancels its reader after the SSE [DONE] frame.
      if (mock) await response.clone().arrayBuffer();
      publish(mock ? 'mock' : gatewayStateForStatus(response.status));
      return response;
    } catch {
      publish('unavailable');
      throw new Error('The gateway is unavailable.');
    }
  };
}
