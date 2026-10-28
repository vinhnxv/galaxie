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
  if (
    name === 'interrupt-resume' ||
    name === 'interrupt-durability-sync' ||
    name === 'interrupt-durability-exit'
  ) {
    expect(transcript.final).toEqual({
      value: 1,
      answer: { answer: 'yes' },
      counts: { prepare: 1, ask: 2 },
    });
    expect(transcript.pauses).toHaveLength(1);
    expect(transcript.pauses?.[0]?.historyLength).toBe(
      name === 'interrupt-durability-exit' ? 1 : 3,
    );
    expect(transcript.checkpoints).toHaveLength(name === 'interrupt-durability-exit' ? 2 : 5);
  } else if (name === 'interrupt-sequence') {
    expect(transcript.final).toEqual({
      value: 1,
      first: 'first',
      second: false,
      counts: { askFirst: 2, askSecond: 2 },
    });
    expect(normalize({ pauses: transcript.pauses })).toMatchObject({
      pauses: [
        { interrupts: [{ id: '<interrupt:1>' }] },
        { interrupts: [{ id: '<interrupt:2>' }] },
      ],
    });
  } else if (name === 'interrupt-subgraph') {
    expect(transcript.final).toEqual({
      value: 1,
      answer: 'inner answer',
      counts: { callSub: 2, s1: 1, sask: 2 },
    });
    expect(transcript.pauses).toHaveLength(1);
  }
  await expect(`${JSON.stringify(normalize(transcript), null, 2)}\n`).toMatchFileSnapshot(
    `./golden/${name}.json`,
  );
  expect(
    compatibilityMatrix.filter((entry) => entry.case === name && entry.lane === 'native'),
  ).toEqual([]);
});
