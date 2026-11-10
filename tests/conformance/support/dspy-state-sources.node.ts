// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';
import { stateSpecs } from './dspy-state.js';

export function selectedStateSource(name: string): string {
  return `# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh\n# SPDX-License-Identifier: Apache-2.0\nfrom state_suite import factory\ndef create_agent():\n    return factory(${JSON.stringify(name)})\n`;
}

export async function dspyStateSources(name: string): Promise<Record<string, string>> {
  const spec = stateSpecs[name];
  if (!spec) throw new Error('The state conformance case is unknown.');
  return {
    'state_suite.py': await readFile(
      new URL('../cases-dspy/state_suite.py', import.meta.url),
      'utf8',
    ),
    'state.json': await readFile(
      new URL(`../cases-dspy/state/${spec.state}.json`, import.meta.url),
      'utf8',
    ),
    'selected.py': selectedStateSource(name),
  };
}
