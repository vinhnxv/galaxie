// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readdir, readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { createPythonFixture } from '../../examples/rag-browser/test/support/python.node.js';
import fixtures from './cases-dspy/optimizer-state-fixtures.json' with { type: 'json' };
import { dspyCases } from './support/dspy.js';
import {
  dspyOptimizerStateCases,
  executeDspyOptimizerStateCase,
} from './support/dspy-optimizer-state.js';
import { dspyOptimizerStateSources } from './support/dspy-optimizer-state-sources.node.js';
import { dspyStateCases } from './support/dspy-state.js';

test.each(dspyOptimizerStateCases)('Node Pyodide loads real optimizer state: %s', async (name) => {
  const fixture = await createPythonFixture({
    framework: 'dspy',
    module: 'selected',
    sources: await dspyOptimizerStateSources(name),
  });
  try {
    const actual = await executeDspyOptimizerStateCase(fixture.options, fixture.agent, name);
    expect(actual).toEqual(
      JSON.parse(
        await readFile(
          new URL(`./golden-dspy-optimizer-state/${name}.json`, import.meta.url),
          'utf8',
        ),
      ),
    );
    expect(fixture.workerErrors).toEqual([]);
    expect(
      fixture.requests.some(
        (request) => request.url === '/python/agent/state.json' && request.bytes > 0,
      ),
    ).toBe(true);
    expect(fixture.requests.every((request) => request.url.startsWith('/python/'))).toBe(true);
    if (name === 'optstate-forgot-lm') {
      expect(actual.error).toEqual({
        code: 'unsupported',
        message: 'This operation is unsupported.',
      });
      expect(actual.requests).toEqual([]);
      expect(actual.capabilities).toEqual([]);
    } else {
      const state = JSON.parse(
        await readFile(
          new URL(`./cases-dspy/optimizer-state/${name}.json`, import.meta.url),
          'utf8',
        ),
      );
      const messages = (actual.requests[0] as { messages: { role: string; content: string }[] })
        .messages;
      expect(messages[0]?.content).toContain(state.signature.instructions);
      for (const [index, demo] of state.demos.entries()) {
        expect(messages[1 + index * 2]?.content).toContain(demo.question);
        expect(messages[2 + index * 2]?.content).toContain(demo.answer);
      }
    }
  } finally {
    await fixture.cleanup();
  }
});

test('optimizer libraries remain absent from the Worker', async () => {
  const fixture = await createPythonFixture({
    framework: 'dspy',
    module: 'selected',
    sources: {
      'selected.py': `# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0
import importlib.util
import dspy
from galaxie.dspy import Executor
class Inventory(dspy.Module):
    async def aforward(self, question):
        return dspy.Prediction(**{name: importlib.util.find_spec(name) is not None for name in ['gepa', 'optuna', 'numpy', 'litellm']})
def create_agent():
    return Executor(Inventory())
`,
    },
  });
  try {
    const actual = await executeDspyOptimizerStateCase(
      fixture.options,
      fixture.agent,
      'optstate-copro',
    );
    expect(actual.error).toBeNull();
    expect(actual.output).toEqual({ gepa: false, optuna: false, numpy: false, litellm: false });
    expect(actual.requests).toEqual([]);
    expect(fixture.workerErrors).toEqual([]);
    expect(fixture.requests.every((request) => request.url.startsWith('/python/'))).toBe(true);
  } finally {
    await fixture.cleanup();
  }
});

test('optimizer states form a separate complete golden family', async () => {
  expect(dspyOptimizerStateCases).toEqual(Object.keys(fixtures));
  expect([...dspyOptimizerStateCases].sort()).toEqual(
    (await readdir(new URL('./golden-dspy-optimizer-state/', import.meta.url)))
      .map((file) => file.replace(/\.json$/, ''))
      .sort(),
  );
  expect(
    dspyOptimizerStateCases.filter(
      (name) => dspyCases.includes(name) || dspyStateCases.includes(name),
    ),
  ).toEqual([]);
});
