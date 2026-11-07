// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { GalaxieError } from '@galaxie/core';
import { type GatewayState, gatewayStateForStatus } from './gateway-state.js';

export interface DemoSession {
  token(): Promise<string>;
  reset(): void;
}

export function createSession(
  baseURL: string,
  fetcher: typeof globalThis.fetch,
  publish: (state: GatewayState) => void,
  now: () => number = Date.now,
): DemoSession {
  let current: { token: string; expiresAt: number } | undefined;
  let refreshing: Promise<string> | undefined;
  return {
    async token() {
      if (current && current.expiresAt > now() + 60_000) return current.token;
      refreshing ??= (async () => {
        try {
          const response = await fetcher(new URL('/api/session', baseURL), {
            method: 'POST',
            credentials: 'omit',
            redirect: 'error',
            cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ userId: 'demo-ada' }),
          });
          if (!response.ok) {
            publish(gatewayStateForStatus(response.status));
            throw new GalaxieError(
              response.status === 401 || response.status === 403 ? 'denied' : 'unavailable',
              'The demo session is unavailable.',
            );
          }
          const value: unknown = await response.json();
          if (
            typeof value !== 'object' ||
            value === null ||
            !('token' in value) ||
            typeof value.token !== 'string' ||
            value.token.length === 0 ||
            !('expiresAt' in value) ||
            typeof value.expiresAt !== 'number' ||
            !Number.isFinite(value.expiresAt) ||
            value.expiresAt <= now() + 60_000
          ) {
            throw new Error('invalid');
          }
          current = { token: value.token, expiresAt: value.expiresAt };
          return current.token;
        } catch (error) {
          if (error instanceof GalaxieError) throw error;
          publish('unavailable');
          throw new GalaxieError('unavailable', 'The demo session is unavailable.');
        }
      })();
      try {
        return await refreshing;
      } finally {
        refreshing = undefined;
      }
    },
    reset() {
      current = undefined;
    },
  };
}
