// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'vitest';
import { CASE_NAMES, cases } from './cases/index.js';
import { compatibilityMatrix } from './support/matrix.js';
import { normalize } from './support/normalize.js';
import { runNative } from './support/transcript.js';

test.each(CASE_NAMES)('native %s matches its golden', async (name) => {
  const langgraph = await import('@langchain/langgraph');
  const transcript = await runNative(cases[name], langgraph);
  expect(transcript.outcome).toEqual(
    name === 'model-failure'
      ? { status: 'failed', errorType: 'FixtureModelError' }
      : name === 'step-limit'
        ? { status: 'failed', errorType: 'GraphRecursionError' }
        : { status: 'succeeded' },
  );
  await expect(`${JSON.stringify(normalize(transcript), null, 2)}\n`).toMatchFileSnapshot(
    `./golden/${name}.json`,
  );
  expect(
    compatibilityMatrix.filter((entry) => entry.case === name && entry.lane === 'native'),
  ).toEqual([]);
});
