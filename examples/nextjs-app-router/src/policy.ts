// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

export function contentSecurityPolicy(nonce: string, development: boolean): string {
  const directives: Readonly<Record<string, readonly string[]>> = {
    'default-src': ["'none'"],
    'script-src': ["'self'", `'nonce-${nonce}'`, ...(development ? ["'unsafe-eval'"] : [])],
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
    'trusted-types': ['nextjs#bundler'],
  };
  return Object.entries(directives)
    .map(([key, values]) => `${key} ${values.join(' ')}`)
    .join('; ');
}
