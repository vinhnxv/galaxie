// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

export const shared = ['@opentelemetry/api', '@langchain/core', '@langchain/langgraph'];

export function singleCopy(
  store = fileURLToPath(new URL('../node_modules/.pnpm', import.meta.url)),
): Plugin {
  const directories = readdirSync(store, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  for (const name of shared) {
    const prefix = `${name.replace('/', '+')}@`;
    const copies = directories.filter((entry) => entry.startsWith(prefix));
    if (copies.length > 1)
      throw new Error(`Multiple installed copies of ${name}: ${copies.join(', ')}`);
  }
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
