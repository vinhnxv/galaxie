// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';
import { parallelGuardSources, parallelSources } from './dspy-parallel-sources.node.js';

export async function branchSources(
  name: string,
  changed:
    | boolean
    | 'removed'
    | 'renamed'
    | 'fewer'
    | 'extra'
    | 'extra-key-first'
    | 'extra-key-last' = false,
): Promise<Record<string, string>> {
  const sources = await parallelSources(
    name,
    true,
    changed === true || changed === 'removed' ? changed : false,
  );
  sources['parallel_candidate.py'] = await readFile(
    new URL('../cases-dspy/shipped_branches.py', import.meta.url),
    'utf8',
  );
  if (typeof changed === 'string' && changed !== 'removed') {
    sources['parallel_candidate.py'] += `
import asyncio
from galaxie import capabilities
from galaxie.dspy import branches as join
async def branches(group):
    group = dict(group)
    if ${JSON.stringify(changed)} == 'renamed':
        group['renamed'] = group.pop('before.alpha')
    elif ${JSON.stringify(changed)} == 'fewer':
        group['before.alpha'] = lambda: asyncio.sleep(0, result='silent')
    else:
        original = group['before.alpha']
        async def added():
            if ${JSON.stringify(changed)} == 'extra':
                await original()
            return await capabilities.call('docs.lookup@1', {'query': 'alpha:added'})
        if ${JSON.stringify(changed)} == 'extra':
            group['before.alpha'] = added
        elif ${JSON.stringify(changed)} == 'extra-key-first':
            group = {'added': added, **group}
        else:
            group['added'] = added
    return await join(group)
`;
  }
  return sources;
}

export async function branchGuardSources(): Promise<Record<string, string>> {
  const sources = await parallelGuardSources();
  sources['parallel_candidate.py'] =
    (await branchSources('par-fan-single'))['parallel_candidate.py'] ?? '';
  return sources;
}
