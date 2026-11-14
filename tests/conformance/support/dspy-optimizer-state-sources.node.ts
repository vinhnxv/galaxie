// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';
import { optimizerStateSpecs } from './dspy-optimizer-state.js';

export function selectedOptimizerStateSource(name: string): string {
  return `# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh\n# SPDX-License-Identifier: Apache-2.0\nfrom optimizer_state_suite import factory\ndef create_agent():\n    return factory(${JSON.stringify(name)})\n`;
}

export async function dspyOptimizerStateSources(name: string): Promise<Record<string, string>> {
  const spec = optimizerStateSpecs[name];
  if (!spec) throw new Error('The state conformance case is unknown.');
  return {
    'optimizer_state_suite.py': await readFile(
      new URL('../cases-dspy/optimizer_state_suite.py', import.meta.url),
      'utf8',
    ),
    'state.json': await readFile(
      new URL(`../cases-dspy/optimizer-state/${spec.state}.json`, import.meta.url),
      'utf8',
    ),
    'selected.py': selectedOptimizerStateSource(name),
  };
}
