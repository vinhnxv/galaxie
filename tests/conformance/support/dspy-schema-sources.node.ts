// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';

export async function dspySchemaSources(
  name: string,
  settings: { pause?: boolean; changed?: boolean } = {},
): Promise<Record<string, string>> {
  return {
    'schema_programs.py': await readFile(
      new URL('../cases-dspy/schema_programs.py', import.meta.url),
      'utf8',
    ),
    'selected.py': `# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0
from schema_programs import factory
def create_agent():
    return factory(${JSON.stringify(name)}, pause=${settings.pause ? 'True' : 'False'}, changed=${settings.changed ? 'True' : 'False'})
`,
  };
}
