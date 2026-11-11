// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const header =
  '# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh\n# SPDX-License-Identifier: Apache-2.0\n';

export async function parallelSources(
  name: string,
  candidate = false,
  changed: boolean | 'removed' = false,
): Promise<Record<string, string>> {
  const sources: Record<string, string> = {
    'parallel_programs.py': await readFile(
      new URL('../cases-dspy/parallel_programs.py', import.meta.url),
      'utf8',
    ),
    'selected.py': `${header}${candidate ? 'from parallel_candidate import install\ninstall()\n' : ''}
import asyncio
from galaxie._bridge import notify_stream_data
from galaxie.dspy import Executor
from parallel_programs import factory
class ObservedExecutor(Executor):
    async def run(self, *args, **kwargs):
        existing = asyncio.all_tasks()
        try:
            return await super().run(*args, **kwargs)
        finally:
            count = len([task for task in asyncio.all_tasks() - existing if not task.done()])
            notify_stream_data([], 'updates', {'kind': 'spike-tasks', 'count': count})
def create_agent():
    executor = factory(${JSON.stringify(name)}, candidate=${candidate ? 'True' : 'False'}, changed=${changed === 'removed' ? "'removed'" : changed ? 'True' : 'False'})
    return ObservedExecutor(executor.module, adapter=executor.adapter)
`,
  };
  if (candidate)
    sources['parallel_candidate.py'] = await readFile(
      new URL('../cases-dspy/parallel_candidate.py', import.meta.url),
      'utf8',
    );
  return sources;
}

/** Independent native DSPy requests; these are computed, never golden files. */
export async function parallelNativeReference(
  shape: 'single' | 'multi' | 'write',
  stage = 'before',
  evaluate = false,
): Promise<{ output: unknown; payloads: unknown[] }> {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const program = `import sys,json\nsys.path.insert(0,'tests/conformance/cases-dspy')\nfrom test_dspy_parallel_baseline import native_reference\noutput,payloads=native_reference(${JSON.stringify(shape)},stage=${JSON.stringify(stage)},evaluate=${evaluate ? 'True' : 'False'})\nprint(json.dumps({'output':output,'payloads':payloads}))`;
  const result = await promisify(execFile)(`${root}/python/.venv/bin/python`, ['-c', program], {
    cwd: root,
    env: { ...process.env, PYTEST_DISABLE_PLUGIN_AUTOLOAD: '1' },
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(result.stdout) as { output: unknown; payloads: unknown[] };
}

/** Batch refusal probes share one Worker without changing the shipped executor. */
export async function parallelGuardSources(): Promise<Record<string, string>> {
  const sources = await parallelSources('par-fan-single', true);
  sources['selected.py'] = `${header}
import asyncio
import dspy
import galaxie.dspy as face
from parallel_candidate import branches, install
install()
class Program(dspy.Module):
    async def aforward(self, question):
        results = {}
        async def value():
            return 'done'
        async def nested():
            return await branches({'inner': value})
        class Duplicate:
            def items(self):
                return [('same', value), ('same', value)]
        for shape in ('invalid', 'duplicate', 'wide', 'nested', 'streaming'):
            active = face._Run('guard', 1, face._Session(), streaming=shape == 'streaming')
            token = face._run.set(active)
            existing = asyncio.all_tasks()
            items = {'one': value}
            if shape == 'invalid': items = {'invalid/key': value}
            elif shape == 'duplicate': items = Duplicate()
            elif shape == 'wide': items = {str(index): value for index in range(33)}
            elif shape == 'nested': items = {'outer': nested}
            try:
                await branches(items)
                results[shape] = 'completed'
            except BaseException as error:
                results[shape] = face.error_code(error)
            finally:
                face._run.reset(token)
            results[shape + '_tasks'] = len(asyncio.all_tasks() - existing)
        return dspy.Prediction(**results)
def create_agent():
    return face.Executor(Program())
`;
  return sources;
}
