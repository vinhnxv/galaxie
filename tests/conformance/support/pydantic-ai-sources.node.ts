// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { readFile } from 'node:fs/promises';
import { pydanticCases } from './pydantic-ai.js';

export async function pydanticSources(name: string): Promise<Record<string, string>> {
  if (!(pydanticCases as readonly string[]).includes(name))
    throw new Error('The conformance case is unknown.');
  return {
    'suite.py': await readFile(new URL('../cases-pydantic-ai/suite.py', import.meta.url), 'utf8'),
    'selected.py': `# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh\n# SPDX-License-Identifier: AGPL-3.0-only\nfrom suite import factory\ndef create_agent():\n    return factory(${JSON.stringify(name)})\n`,
  };
}
