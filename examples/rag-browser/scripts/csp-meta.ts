// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { Plugin } from 'vite';
import { cspDirectives, cspHeader } from '../src/host/csp.js';

export function cspMetaValue(mode: string): string {
  return Object.entries(cspDirectives(mode))
    .filter(([directive]) => directive !== 'frame-ancestors')
    .map(([directive, sources]) => `${directive} ${sources.join(' ')}`)
    .join('; ');
}

export function cspMeta(mode: string): Plugin {
  return {
    name: 'rag-csp-meta',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler() {
        return [
          {
            tag: 'meta',
            attrs: {
              'http-equiv': 'Content-Security-Policy',
              content: cspMetaValue(mode),
            },
            injectTo: 'head-prepend' as const,
          },
        ];
      },
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: '_headers',
        source: `/*\n  Content-Security-Policy: ${cspHeader(mode)}\n`,
      });
    },
  };
}
