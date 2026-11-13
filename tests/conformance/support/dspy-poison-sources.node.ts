// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';

export type PoisonVariant =
  | 'original'
  | 'changed'
  | 'removed'
  | 'data'
  | 'data-request'
  | 'same-instance';

export async function poisonSources(
  variant: PoisonVariant,
  catalog = 'original',
  unrelated?: string,
): Promise<Record<string, string>> {
  const header =
    '# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh\n# SPDX-License-Identifier: Apache-2.0\n';
  return {
    'binding_poison_programs.py': await readFile(
      new URL('../cases-dspy/binding_poison_programs.py', import.meta.url),
      'utf8',
    ),
    'selected.py': `${header}from binding_poison_programs import create_agent as build\ndef create_agent():\n    return build(${JSON.stringify(variant)})\n`,
    ...(variant.startsWith('data')
      ? { 'catalog.py': `${header}VALUE = ${JSON.stringify(catalog)}\n` }
      : {}),
    ...(unrelated === undefined ? {} : { 'unrelated.json': unrelated }),
  };
}
