// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { GalaxieError } from './errors.js';

export function isLoopback(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
}

/** Classifies a URL hostname literally; never resolves DNS or changes URL permissions. */
export function isPrivateAddress(hostname: string): boolean {
  if (/\.local\.?$/i.test(hostname)) return true;
  if (/^\[(?:f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)/i.test(hostname)) return true;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return false;
  const parts = hostname.split('.').map(Number);
  if (parts.some((part) => part > 255)) return false;
  const [first, second = 0] = parts;
  return (
    first === 10 ||
    first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
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
