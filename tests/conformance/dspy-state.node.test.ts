// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readdir, readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { createPythonFixture } from '../../examples/rag-browser/test/support/python.node.js';
import fixtures from './cases-dspy/state-fixtures.json' with { type: 'json' };
import { dspyCases } from './support/dspy.js';
import { dspyStateCases, executeDspyStateCase } from './support/dspy-state.js';
import { dspyStateSources } from './support/dspy-state-sources.node.js';

test.each(dspyStateCases)(
  'Node Pyodide loads offline DSPy state: %s',
  async (name) => {
    const fixture = await createPythonFixture({
      framework: 'dspy',
      module: 'selected',
      sources: await dspyStateSources(name),
    });
    try {
      const actual = await executeDspyStateCase(fixture.options, fixture.agent, name);
      expect(actual).toEqual(
        JSON.parse(
          await readFile(new URL(`./golden-dspy-state/${name}.json`, import.meta.url), 'utf8'),
        ),
      );
      expect(fixture.workerErrors).toEqual([]);
      expect(
        fixture.requests.some(
          (request) => request.url === '/python/agent/state.json' && request.bytes > 0,
        ),
      ).toBe(true);
      expect(fixture.requests.every((request) => request.url.startsWith('/python/'))).toBe(true);
      if (name === 'state-predict-demos') {
        const messages = (actual.requests[0] as { messages: { role: string; content: string }[] })
          .messages;
        expect(messages.map((message) => message.role)).toEqual([
          'system',
          'user',
          'assistant',
          'user',
          'assistant',
          'user',
        ]);
        expect(messages[1]?.content).toContain('What is the capital of Spain?');
        expect(messages[3]?.content).toContain('What is the capital of Italy?');
      }
      if (name === 'state-hostile-lm' || name === 'state-forgot-lm') {
        expect(actual.error).toEqual({
          code: 'unsupported',
          message: 'This operation is unsupported.',
        });
        expect(actual.requests).toEqual([]);
        expect(actual.capabilities).toEqual([]);
      }
    } finally {
      await fixture.cleanup();
    }
  },
  60000,
);

test('the offline DSPy cases form a separate, complete golden family', async () => {
  expect(dspyStateCases).toEqual(Object.keys(fixtures));
  expect([...dspyStateCases].sort()).toEqual(
    (await readdir(new URL('./golden-dspy-state/', import.meta.url)))
      .map((file) => file.replace(/\.json$/, ''))
      .sort(),
  );
  expect(dspyStateCases.filter((name) => dspyCases.includes(name))).toEqual([]);
});
