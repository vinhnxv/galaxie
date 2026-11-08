// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { GalaxieError } from '@galaxie-ai/core';

export function createSession(origin: string, now: () => number = Date.now): () => Promise<string> {
  let session: { token: string; expiresAt: number } | undefined;
  let refreshing: Promise<string> | undefined;
  return async () => {
    if (session && session.expiresAt > now() + 60_000) return session.token;
    refreshing ??= (async () => {
      try {
        const response = await fetch(`${origin}/api/session`, {
          method: 'POST',
          credentials: 'omit',
          redirect: 'error',
          cache: 'no-store',
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error();
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
  };
}
