// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';

export async function delegationSuiteSources(name: string): Promise<Record<string, string>> {
  return {
    'delegation_suite.py': await readFile(
      new URL('../cases-pydantic-ai-delegation-suite/delegation_suite.py', import.meta.url),
      'utf8',
    ),
    'fixtures.json': await readFile(
      new URL('../cases-pydantic-ai-delegation-suite/fixtures.json', import.meta.url),
      'utf8',
    ),
    'selected.py': `# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh\n# SPDX-License-Identifier: Apache-2.0\nfrom delegation_suite import factory\ndef create_agent():\n    return factory(${JSON.stringify(name)})\n`,
  };
}
