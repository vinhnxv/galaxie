// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { createPythonFixture } from '../../examples/rag-browser/test/support/python.node.js';
import { createPyodideAdapter } from '../../packages/adapter-pyodide/src/adapter.js';
import { dspyCases, executeDspyCase } from './support/dspy.js';
import { dspyRejectedRestoreCases, dspyReloadCases } from './support/dspy-restore.js';
import { dspySources } from './support/dspy-sources.node.js';

test.each([
  ...dspyCases.map((name) => ({ name, steps: undefined as number | undefined })),
  { name: 'pause-two', steps: 1 },
  { name: 'pause-two', steps: 2 },
])(
  'Node Pyodide matches native DSPy requests, tools and output: $name (steps=$steps)',
  async ({ name, steps }) => {
    const fixture = await createPythonFixture({
      framework: 'dspy',
      module: 'selected',
      sources: await dspySources(name),
    });
    try {
      const actual = await executeDspyCase(fixture.options, fixture.agent, name, steps);
      if (steps === 1) {
        expect(actual.error).toEqual({
          code: 'budget_exceeded',
          message: 'The budget limit was reached.',
        });
        expect(actual.requests).toHaveLength(2);
        expect(actual.capabilities).toHaveLength(1);
        expect(actual.interactions).toHaveLength(2);
        expect(actual.output).toBeNull();
      } else {
        expect(actual).toEqual(
          JSON.parse(
            await readFile(new URL(`./golden-dspy/${name}.json`, import.meta.url), 'utf8'),
          ),
        );
      }
      expect(fixture.workerErrors).toEqual([]);
      if (name === 'reply-block' || name === 'stream-mid-block')
        expect(fixture.toWorker.join('\n')).not.toContain('BLOCKED_TEXT');
      if (name === 'argument-block' || name === 'stream-argument-block')
        expect(fixture.toWorker.join('\n')).not.toContain('BLOCKED_ARGUMENT');
    } finally {
      await fixture.cleanup();
    }
  },
  60000,
);

test('the DSPy compatibility matrix lists every case and the adapter features', async () => {
  const matrix = JSON.parse(
    await readFile(new URL('./compatibility-matrix-dspy.json', import.meta.url), 'utf8'),
  );
  expect([...matrix.cases].sort()).toEqual(
    [...dspyCases, ...dspyReloadCases, ...dspyRejectedRestoreCases].sort(),
  );
  expect(matrix.features).toEqual(
    createPyodideAdapter({
      framework: 'dspy',
      runtimeUrl: '',
      wheelsUrl: '',
      localWheels: [],
      createWorker: () => {
        throw new Error('The matrix check starts no Worker.');
      },
    }).features,
  );
});
