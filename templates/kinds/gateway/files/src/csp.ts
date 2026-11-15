// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

export function cspDirectives(): Readonly<Record<string, readonly string[]>> {
  return {
    'default-src': ["'none'"],
    'script-src': ["'self'"],
    'worker-src': ["'self'"],
    'connect-src': ["'self'"],
    'style-src': ["'self'"],
    'img-src': ["'self'"],
    'font-src': ["'self'"],
    'media-src': ["'none'"],
    'form-action': ["'none'"],
    'frame-src': ["'none'"],
    'frame-ancestors': ["'none'"],
    'base-uri': ["'none'"],
    'object-src': ["'none'"],
    'manifest-src': ["'self'"],
    'require-trusted-types-for': ["'script'"],
    'trusted-types': ["'none'"],
  };
}

export function cspHeader(): string {
  return Object.entries(cspDirectives())
    .map(([directive, sources]) => `${directive} ${sources.join(' ')}`)
    .join('; ');
}
