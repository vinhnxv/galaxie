// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

export function cspDirectives(mode: string): Readonly<Record<string, readonly string[]>> {
  return {
    'default-src': ["'none'"],
    'script-src': ["'self'", "'wasm-unsafe-eval'"],
    'worker-src': ["'self'"],
    'connect-src':
      mode === 'mock'
        ? ["'self'"]
        : [
            "'self'",
            'https://huggingface.co',
            'https://*.hf.co',
            'https://raw.githubusercontent.com',
          ],
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
    'trusted-types': mode === 'mock' ? ["'none'"] : ['default'],
  };
}

export function cspHeader(mode: string): string {
  return Object.entries(cspDirectives(mode))
    .map(([directive, sources]) => `${directive} ${sources.join(' ')}`)
    .join('; ');
}
