// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { EventId, RunEvent, RunId } from '@galaxie/core';
import { AIMessageChunk } from '@langchain/core/messages';
import { expect, test } from 'vitest';
import { answerDelta } from '../src/host/stream.js';

function stream(data: unknown, mode = 'messages'): RunEvent {
  return {
    type: 'stream',
    executor: 'fixture',
    path: [],
    mode,
    data,
    eventId: 'event' as EventId,
    runId: 'run' as RunId,
    sequence: 0,
  };
}

test('accepts answer text from native JavaScript chunks and the Python JSON projection', () => {
  for (const message of [
    new AIMessageChunk('Checked text.'),
    { type: 'AIMessageChunk', content: 'Checked text.', id: null },
  ]) {
    expect(answerDelta(stream([message, { langgraph_node: 'generateAnswer' }]))).toBe(
      'Checked text.',
    );
  }
});

test('keeps graph state, other nodes and tool-call messages out of answer display', () => {
  const privateState = { passages: [{ text: 'Private working passage.' }] };
  const ai = { type: 'ai', content: 'Private working passage.' };
  for (const event of [
    stream(privateState, 'values'),
    stream({ generateAnswer: privateState }, 'updates'),
    stream([ai, { langgraph_node: 'retrieve' }]),
    stream([{ ...ai, tool_calls: [{ name: 'untrusted' }] }, { langgraph_node: 'generateAnswer' }]),
    stream([{ type: 'human', content: 'Private question.' }, { langgraph_node: 'generateAnswer' }]),
  ])
    expect(answerDelta(event)).toBe('');
});
