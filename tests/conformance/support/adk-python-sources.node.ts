// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';
import { adkPythonCases } from './adk-python.js';
import { adkPythonWriteCases } from './adk-python-restore.js';

export async function adkPythonSources(name: string): Promise<Record<string, string>> {
  if (!(adkPythonCases as readonly string[]).includes(name))
    throw new Error('The conformance case is unknown.');
  return {
    'suite.py': await readFile(new URL('../cases-adk-python/suite.py', import.meta.url), 'utf8'),
    'selected.py': `# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh\n# SPDX-License-Identifier: Apache-2.0\nfrom suite import factory\ndef create_agent():\n    return factory(${JSON.stringify(name)})\n`,
  };
}

/** The agent of a write case: one write capability, gated by a confirmation or by a read tool. */
export async function adkPythonWriteSources(name: string): Promise<Record<string, string>> {
  if (!(adkPythonWriteCases as readonly string[]).includes(name))
    throw new Error('The conformance case is unknown.');
  return {
    'suite.py': await readFile(new URL('../cases-adk-python/suite.py', import.meta.url), 'utf8'),
    'selected.py': `# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0
from google.adk.agents import LlmAgent
from galaxie.adk import Executor, capability_tool, llm
from suite import PARAMETERS, interaction
NAME = ${JSON.stringify(name)}
def create_agent():
    tools = [capability_tool('double', 'math.double@1', PARAMETERS, 'Double an integer.', require_confirmation=NAME == 'approved-write')]
    if NAME == 'resumed-write':
        tools.insert(0, capability_tool('confirm', 'math.confirm@1', PARAMETERS, 'Ask first.', require_confirmation=True))
    agent = LlmAgent(name='conformance', model=llm('answer'), instruction='Use the supplied tools and answer briefly.', tools=tools)
    return Executor(agent, interaction=interaction)
`,
  };
}
