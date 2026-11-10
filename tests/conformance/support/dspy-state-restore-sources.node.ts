// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';
import fixtures from '../cases-dspy/state-durable-fixtures.json' with { type: 'json' };
import type { StateRestoreScenario } from './dspy-state-restore.js';

export async function stateRestoreSources(
  scenario: StateRestoreScenario,
  lifetime: 'pause' | 'resume',
): Promise<Record<string, string>> {
  const swap = fixtures.swaps[lifetime === 'pause' ? 'same' : scenario.swap];
  let state = await readFile(
    new URL(`../cases-dspy/state/${swap.state}.json`, import.meta.url),
    'utf8',
  );
  if ('set' in swap) state = JSON.stringify({ ...JSON.parse(state), ...swap.set });
  return {
    'state_durable.py': await readFile(
      new URL('../cases-dspy/state_durable.py', import.meta.url),
      'utf8',
    ),
    'state.json': state,
    'selected.py': `# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh\n# SPDX-License-Identifier: Apache-2.0\nfrom state_durable import factory\ndef create_agent():\n    return factory(${JSON.stringify(scenario.program)})\n`,
  };
}
