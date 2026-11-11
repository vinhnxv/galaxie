// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';
import type { StateBindScenario } from './dspy-state-bind.js';
import { stateRestoreSources } from './dspy-state-restore-sources.node.js';

export async function stateBindSources(
  scenario: StateBindScenario,
  lifetime: 'pause' | 'resume',
): Promise<Record<string, string>> {
  const sources = await stateRestoreSources({ ...scenario, outcome: scenario.predicted }, lifetime);
  const selected = sources['selected.py'];
  if (selected === undefined) throw new Error('The selected source is missing.');
  return {
    ...sources,
    'state_bind_candidate.py': await readFile(
      new URL('../cases-dspy/state_bind_candidate.py', import.meta.url),
      'utf8',
    ),
    'selected.py':
      scenario[lifetime === 'pause' ? 'pauseWith' : 'resumeWith'] === 'candidate'
        ? `${selected}\nfrom pathlib import Path\nfrom state_bind_candidate import install\ninstall(Path('/agent'))\n`
        : selected,
  };
}
