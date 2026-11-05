// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { EventId, RunEvent, RunId } from '@galaxie/core';
import { AIMessageChunk } from '@langchain/core/messages';
import { expect, test } from 'vitest';
import { answerDelta, startsModelTurn } from '../src/host/stream.js';

function stream(data: unknown, mode = 'messages'): Extract<RunEvent, { type: 'stream' }> {
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

test('pydantic-ai displays only its checked text projection', () => {
  const event: RunEvent = {
    ...stream([{ type: 'ai', content: 'Answer [1]' }, {}]),
    executor: 'pydantic-ai-python',
  };
  expect(answerDelta(event)).toBe('Answer [1]');
  expect(answerDelta({ ...event, mode: 'updates' })).toBe('');
  expect(
    answerDelta({ ...event, data: [{ type: 'ai', content: 'private', tool_calls: [{}] }, {}] }),
  ).toBe('');
});

test('marks each pydantic-ai model request as a new answer turn', () => {
  const request = {
    ...stream({ kind: 'model-request', index: 1 }, 'updates'),
    executor: 'pydantic-ai-python',
  };
  expect(startsModelTurn(request)).toBe(true);
  expect(
    startsModelTurn({ ...request, data: { kind: 'tool-call', name: 'search_docs', index: 0 } }),
  ).toBe(false);
  expect(startsModelTurn({ ...request, executor: 'langgraph-python' })).toBe(false);
  expect(startsModelTurn(stream({ kind: 'model-request', index: 1 }))).toBe(false);
});

test('DSPy displays only its checked answer field and resets for each model call', () => {
  const event: RunEvent = {
    ...stream({ field: 'answer', text: 'Answer [1]' }),
    executor: 'dspy-python',
  };
  expect(answerDelta(event)).toBe('Answer [1]');
  expect(answerDelta({ ...event, data: { field: 'reasoning', text: 'Hidden rationale.' } })).toBe(
    '',
  );
  expect(answerDelta({ ...event, mode: 'updates' })).toBe('');
  expect(answerDelta({ ...event, executor: 'fixture' })).toBe('');
  const request = { ...event, mode: 'updates', data: { kind: 'model', index: 1 } };
  expect(startsModelTurn(request)).toBe(true);
  expect(startsModelTurn({ ...request, data: { kind: 'replayed', count: 1 } })).toBe(false);
  expect(startsModelTurn({ ...request, mode: 'messages' })).toBe(false);
});
