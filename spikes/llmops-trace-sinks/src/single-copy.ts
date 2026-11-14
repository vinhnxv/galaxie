// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

export const shared = ['@opentelemetry/api', '@langchain/core', '@langchain/langgraph'];

export function singleCopy(): Plugin {
  return {
    name: 'spike-single-copy',
    enforce: 'pre',
    resolveId(source) {
      if (shared.some((name) => source === name || source.startsWith(`${name}/`)))
        return fileURLToPath(import.meta.resolve(source));
      return null;
    },
  };
}
