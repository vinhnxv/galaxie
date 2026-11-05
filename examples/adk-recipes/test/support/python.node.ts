// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';
import {
  createPythonFixture,
  type PythonFixture,
} from '../../../rag-browser/test/support/python.node.js';
import { auditorAgent } from '../../src/recipes/llm-auditor/definition.js';
import { loanAgent } from '../../src/recipes/loan/definition.js';

export {
  missingPythonWheels,
  pythonWheelsAvailable,
} from '../../../rag-browser/test/support/python.node.js';

export async function recipeFixture(recipe: 'llm_auditor' | 'loan'): Promise<PythonFixture> {
  const sources: Record<string, string> = {};
  const agent = (recipe === 'loan' ? loanAgent : auditorAgent)(
    new URL('../../agent_py/', import.meta.url).href,
  );
  for (const file of agent.files)
    sources[file] = await readFile(new URL(file, agent.baseUrl), 'utf8');
  return createPythonFixture({
    framework: 'adk',
    sources,
    module: agent.module,
    entry: agent.entry,
  });
}
