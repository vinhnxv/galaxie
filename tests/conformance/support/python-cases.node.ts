// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { readFile } from 'node:fs/promises';

export async function pythonCaseSources(name: string): Promise<Record<string, string>> {
  const module = [
    'allow',
    'block',
    'cancel',
    'close',
    'close-block',
    'non-json',
    'oversized',
  ].includes(name)
    ? 'streaming'
    : name.replaceAll('-', '_');
  const files = new Set(['fixture_support', 'interrupt_resume', module]);
  const sources: Record<string, string> = {};
  for (const file of files)
    sources[`${file}.py`] = await readFile(
      new URL(`../cases-python/${file}.py`, import.meta.url),
      'utf8',
    );
  sources['selected.py'] =
    `# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh\n# SPDX-License-Identifier: AGPL-3.0-only\nfrom ${module} import factory\nfrom galaxie.langgraph import checkpointer, request_interaction\nfrom galaxie.capabilities import call\n${['model-without-config', 'model-failure'].includes(name) ? 'from galaxie.langchain import GalaxieChatModel\n' : ''}def create_agent():\n    return factory(checkpointer(), interaction=request_interaction, capability=call${['model-without-config', 'model-failure'].includes(name) ? ", model=GalaxieChatModel(role='answer')" : ''})\n`;
  return sources;
}
