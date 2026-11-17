// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { type Dirent, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

export const shared = ['@opentelemetry/api', '@langchain/core', '@langchain/langgraph'];

export function singleCopy(
  store = fileURLToPath(new URL('../node_modules/.pnpm', import.meta.url)),
): Plugin {
  let entries: Dirent[];
  try {
    entries = readdirSync(store, { withFileTypes: true });
  } catch {
    throw new Error('Run pnpm install in spikes/llmops-trace-sinks before this check.');
  }
  const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
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
