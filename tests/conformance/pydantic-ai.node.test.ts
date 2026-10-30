// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import {
  createPythonFixture,
  missingPythonWheels,
  pythonWheelsAvailable,
} from '../../examples/rag-browser/test/support/python.node.js';
import { executePydanticCase, pydanticCases } from './support/pydantic-ai.js';
import { pydanticSources } from './support/pydantic-ai-sources.node.js';

test.skipIf(!pythonWheelsAvailable).each(pydanticCases)(
  pythonWheelsAvailable
    ? 'Node Pyodide matches native pydantic-ai requests and output: %s'
    : missingPythonWheels,
  async (name) => {
    const fixture = await createPythonFixture({
      sources: await pydanticSources(name),
      module: 'selected',
    });
    try {
      const actual = await executePydanticCase(fixture.options, fixture.agent, name);
      const golden = JSON.parse(
        await readFile(new URL(`./golden-pydantic-ai/${name}.json`, import.meta.url), 'utf8'),
      );
      expect(actual).toEqual(golden);
      expect(fixture.workerErrors).toEqual([]);
      if (name === 'argument-block')
        expect(fixture.toWorker.join('\n')).not.toContain('BLOCKED_ARGUMENT');
    } finally {
      await fixture.cleanup();
    }
  },
  60000,
);
