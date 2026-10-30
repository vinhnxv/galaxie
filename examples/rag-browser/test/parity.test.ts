// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'vitest';
import {
  assertTranscript,
  goldenTranscript,
  parityScript,
  replayJavaScript,
} from './support/transcript.js';

test('JavaScript replays the shared behavioral transcript', async () => {
  assertTranscript(await replayJavaScript(parityScript), goldenTranscript);
});

test('the transcript comparison ignores object key order', () => {
  expect(() =>
    assertTranscript(
      [{ output: { answer: 'Paris', citations: [] } }],
      [{ output: { citations: [], answer: 'Paris' } }],
    ),
  ).not.toThrow();
});

test('the transcript comparison identifies a changed model reply in the output', async () => {
  const altered = {
    ...parityScript,
    session: parityScript.session.map((item, index) =>
      index === 0 ? { ...item, model: { ...item.model, reply: 'Lyon is the capital [1].' } } : item,
    ),
  };
  const transcript = await replayJavaScript(altered);
  expect(() => assertTranscript(transcript, goldenTranscript)).toThrow(
    'The transcript differs at $[2].output.answer.',
  );
});
