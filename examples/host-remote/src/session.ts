// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { GalaxieError } from '@galaxie-ai/core';

export function createSession(
  origin: string,
  now: () => number = Date.now,
): (() => Promise<string>) & { end(): Promise<void> } {
  let session: { token: string; expiresAt: number } | undefined;
  let refreshing: Promise<string> | undefined;
  let ending: Promise<void> | undefined;

  async function post(path: '/api/session' | '/api/v1/session/end'): Promise<Response> {
    const response = await fetch(`${origin}${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      // Node callers have no ambient Origin; browsers ignore this script-set header.
      headers: { origin },
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error();
    return response;
  }

  async function token(): Promise<string> {
    if (ending) await ending.catch(() => undefined);
    if (session && session.expiresAt > now() + 60_000) return session.token;
    refreshing ??= (async () => {
      try {
        const response = await post('/api/session');
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
        )
          throw new Error();
        session = { token: value.token, expiresAt: value.expiresAt };
        return session.token;
      } catch {
        throw new GalaxieError('unavailable', 'The session is unavailable.');
      }
    })();
    try {
      return await refreshing;
    } finally {
      refreshing = undefined;
    }
  }

  function end(): Promise<void> {
    ending ??= (async () => {
      try {
        // Let issuance finish setting its cookie before sending the end request.
        await refreshing?.catch(() => {});
        await post('/api/v1/session/end');
      } catch {
        throw new GalaxieError('unavailable', 'The session could not be ended.');
      } finally {
        session = undefined;
        ending = undefined;
      }
    })();
    return ending;
  }

  return Object.assign(token, { end });
}
