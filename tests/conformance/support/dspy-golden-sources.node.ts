// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';
import { providerSources } from './dspy-provider-sources.node.js';
import { runtimeSources } from './dspy-runtime-sources.node.js';

export async function dspyGoldenSources(name: string): Promise<Record<string, string>> {
  if (name.startsWith('rt-')) return runtimeSources(name);
  if (name.startsWith('pe-')) return providerSources(name);
  if (name !== 'rag-docs-search') throw new Error('The retrieval golden program is unknown.');
  return {
    'selected.py': await readFile(
      new URL('../cases-dspy/retrieval_programs.py', import.meta.url),
      'utf8',
    ),
  };
}
