// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { GalaxieError } from './errors.js';

export function isLoopback(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
}

export function isHttpDestination(url: URL): boolean {
  return url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url.hostname));
}

export function normalizeUrlAllowlist(origins: readonly string[] = []): readonly string[] {
  const invalid = (): never => {
    throw new GalaxieError('invalid', 'The URL allowlist is invalid.');
  };
  if (!Array.isArray(origins)) invalid();
  return Object.freeze(
    origins.map((origin) => {
      if (typeof origin !== 'string' || !/^https?:\/\/[^\s/?#\\@]+\/?$/i.test(origin)) invalid();
      let url: URL;
      try {
        url = new URL(origin);
      } catch {
        return invalid();
      }
      if (!isHttpDestination(url) || url.username !== '' || url.password !== '') invalid();
      return url.origin;
    }),
  );
}
