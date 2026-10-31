// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { createPythonFixture } from '../../examples/rag-browser/test/support/python.node.js';
import { dspyCases, executeDspyCase } from './support/dspy.js';
import { dspySources } from './support/dspy-sources.node.js';

test.each(dspyCases)(
  'Node Pyodide matches native DSPy requests, tools and output: %s',
  async (name) => {
    const fixture = await createPythonFixture({
      framework: 'dspy',
      module: 'selected',
      sources: await dspySources(name),
    });
    try {
      const actual = await executeDspyCase(fixture.options, fixture.agent, name);
      expect(actual).toEqual(
        JSON.parse(await readFile(new URL(`./golden-dspy/${name}.json`, import.meta.url), 'utf8')),
      );
      expect(fixture.workerErrors).toEqual([]);
      if (name === 'reply-block') expect(fixture.toWorker.join('\n')).not.toContain('BLOCKED_TEXT');
      if (name === 'argument-block')
        expect(fixture.toWorker.join('\n')).not.toContain('BLOCKED_ARGUMENT');
    } finally {
      await fixture.cleanup();
    }
  },
  60000,
);
