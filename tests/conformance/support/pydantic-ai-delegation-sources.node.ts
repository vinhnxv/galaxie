// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';

export async function delegationSources(
  name = 'smoke',
  variant = 'helper',
): Promise<Record<string, string>> {
  return {
    'delegation.py': await readFile(
      new URL('../cases-pydantic-ai-delegation/delegation.py', import.meta.url),
      'utf8',
    ),
    'fixtures.json': await readFile(
      new URL('../cases-pydantic-ai-delegation/fixtures.json', import.meta.url),
      'utf8',
    ),
    'selected.py': `# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh\n# SPDX-License-Identifier: Apache-2.0\nfrom delegation import factory\ndef create_agent():\n    return factory(${JSON.stringify(name)}, ${JSON.stringify(variant)})\n`,
  };
}
