// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const header =
  '# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh\n# SPDX-License-Identifier: Apache-2.0\n';

export async function providerSources(name: string): Promise<Record<string, string>> {
  return {
    'provider_programs.py': await readFile(
      new URL('../cases-dspy/provider_programs.py', import.meta.url),
      'utf8',
    ),
    'selected.py': `${header}
import asyncio
from galaxie._bridge import notify_stream_data
from galaxie.dspy import Executor
from provider_programs import factory
class ObservedExecutor(Executor):
    async def run(self, *args, **kwargs):
        existing = asyncio.all_tasks()
        try:
            return await super().run(*args, **kwargs)
        finally:
            count = len([task for task in asyncio.all_tasks() - existing if not task.done()])
            notify_stream_data([], 'updates', {'kind': 'spike-tasks', 'count': count})
def create_agent():
    executor = factory(${JSON.stringify(name)})
    return ObservedExecutor(executor.module, adapter=executor.adapter)
`,
  };
}

export async function providerNativeReference(
  kind: 'control' | 'literal',
): Promise<{ output: unknown; requests: unknown[] }> {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const program = `import sys,json
sys.path.insert(0,'tests/conformance/cases-dspy')
from test_dspy_provider import native_reference_plain
print(json.dumps(native_reference_plain(${JSON.stringify(kind)})))`;
  const result = await promisify(execFile)(`${root}/python/.venv/bin/python`, ['-c', program], {
    cwd: root,
    env: { ...process.env, PYTEST_DISABLE_PLUGIN_AUTOLOAD: '1' },
    timeout: 900000,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(result.stdout) as { output: unknown; requests: unknown[] };
}
