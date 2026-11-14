// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import { INTERRUPT_TWICE_CASE_NAMES, interruptTwiceCases } from './cases/interrupt-twice.js';
import { normalize } from './support/normalize.js';
import { runNative } from './support/transcript.js';

test.each(INTERRUPT_TWICE_CASE_NAMES)('native %s matches its golden', async (name) => {
  const native = await import('@langchain/langgraph');
  const transcript = await runNative(interruptTwiceCases[name], native);
  expect(transcript.outcome).toEqual({ status: 'succeeded' });
  expect(transcript.pauses).toHaveLength(2);
  expect(transcript.pauses?.[0]?.interrupts[0]?.id).toBeTruthy();
  expect(transcript.pauses?.[1]?.interrupts[0]?.id).toBe(transcript.pauses?.[0]?.interrupts[0]?.id);
  expect(transcript.state.next).toEqual([]);
  expect(transcript.final).toEqual({ value: 1, first: 'first', second: false, executions: 3 });
  await expect(`${JSON.stringify(normalize(transcript), null, 2)}\n`).toMatchFileSnapshot(
    `./golden/${name}.json`,
  );
});
