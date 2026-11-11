// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';

export async function childApprovalSuiteSources(
  names: readonly string[],
): Promise<Record<string, string>> {
  return {
    'child_approval_suite.py': await readFile(
      new URL('../cases-pydantic-ai-child-approval/child_approval_suite.py', import.meta.url),
      'utf8',
    ),
    'fixtures.json': await readFile(
      new URL('../cases-pydantic-ai-child-approval/fixtures.json', import.meta.url),
      'utf8',
    ),
    'selected.py': `# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh\n# SPDX-License-Identifier: Apache-2.0\nfrom child_approval_suite import factory\n${names.map((name) => `def ${name.replaceAll('-', '_')}():\n    return factory(${JSON.stringify(name)})\n`).join('')}`,
  };
}
