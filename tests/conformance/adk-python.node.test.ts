// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import {
  createPythonFixture,
  missingPythonWheels,
  pythonWheelsAvailable,
} from '../../examples/rag-browser/test/support/python.node.js';
import { createPyodideAdapter } from '../../packages/adapter-pyodide/src/adapter.js';
import { adkPythonCases, executeAdkPythonCase } from './support/adk-python.js';
import { adkPythonSources } from './support/adk-python-sources.node.js';

test.skipIf(!pythonWheelsAvailable).each(adkPythonCases)(
  pythonWheelsAvailable
    ? 'Node Pyodide matches native ADK Python requests, tools and output: %s'
    : missingPythonWheels,
  async (name) => {
    const fixture = await createPythonFixture({
      framework: 'adk',
      sources: await adkPythonSources(name),
      module: 'selected',
    });
    try {
      const actual = await executeAdkPythonCase(fixture.options, fixture.agent, name);
      const golden = JSON.parse(
        await readFile(new URL(`./golden-adk-python/${name}.json`, import.meta.url), 'utf8'),
      );
      expect(actual).toEqual(golden);
      expect(fixture.workerErrors).toEqual([]);
      if (name === 'argument-block')
        expect(fixture.toWorker.join('\n')).not.toContain('BLOCKED_ARGUMENT');
    } finally {
      await fixture.cleanup();
    }
  },
  90000,
);

test('the ADK Python compatibility matrix lists every case and the adapter features', async () => {
  const matrix = JSON.parse(
    await readFile(new URL('./compatibility-matrix-adk-python.json', import.meta.url), 'utf8'),
  );
  expect([...matrix.cases].sort()).toEqual([...adkPythonCases].sort());
  expect(matrix.differences).toEqual([]);
  expect(matrix.features).toEqual(
    createPyodideAdapter({
      framework: 'adk',
      runtimeUrl: '',
      wheelsUrl: '',
      localWheels: [],
      createWorker: () => {
        throw new Error('The matrix check starts no Worker.');
      },
    }).features,
  );
});
