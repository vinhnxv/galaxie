// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import {
  assertCallConsistency,
  assertOrder,
  renumber,
  renumberPerAgent,
} from './support/adk-python.js';

function history(
  agent: string,
  ...ids: string[]
): { agent: string; messages: Record<string, unknown>[] }[] {
  const messages: Record<string, unknown>[] = [{ role: 'user', content: 'question' }];
  const requests = [{ agent, messages: structuredClone(messages) }];
  for (const id of ids) {
    messages.push({ role: 'assistant', tool_calls: [{ id }] }, { role: 'tool', tool_call_id: id });
    requests.push({ agent, messages: structuredClone(messages) });
  }
  return requests;
}

test('single-call histories keep the existing per-request labels', () => {
  const requests = [...history('left', 'left-raw'), ...history('right', 'right-raw')];
  const perAgent = structuredClone(requests);
  for (const request of requests) renumber([request]);
  expect(requests).toEqual([...history('left', 'call-1'), ...history('right', 'call-1')]);
  renumberPerAgent(perAgent);
  expect(perAgent).toEqual(requests);
});

test('two calls retain their labels across three requests and agents number independently', () => {
  const requests = [...history('left', 'raw-a', 'raw-b'), ...history('right', 'raw-a', 'raw-b')];
  expect(() => assertCallConsistency(requests)).not.toThrow();
  renumberPerAgent(requests);
  expect(requests).toEqual([
    ...history('left', 'call-1', 'call-2'),
    ...history('right', 'call-1', 'call-2'),
  ]);
});

test.each([
  {
    messages: [{ role: 'tool', tool_call_id: 'dangling' }],
    error: 'A tool response must match one earlier unanswered assistant call.',
  },
  {
    messages: [{ role: 'assistant', tool_calls: [{ id: 'duplicate' }, { id: 'duplicate' }] }],
    error: 'Assistant call IDs must be unique within a request.',
  },
  {
    messages: [
      { role: 'assistant', tool_calls: [{ id: 'answered' }] },
      { role: 'tool', tool_call_id: 'answered' },
      { role: 'tool', tool_call_id: 'answered' },
    ],
    error: 'A tool response must match one earlier unanswered assistant call.',
  },
])('inconsistent raw call history is refused: $messages', ({ messages, error }) => {
  expect(() => assertCallConsistency([{ agent: 'left', messages }])).toThrow(error);
});

test('a consistently changed call id still fails the prefix check between requests', () => {
  const requests = history('left', 'old', 'next');
  const last = requests.at(-1);
  if (!last) throw new Error('The test history is missing.');
  last.messages = history('left', 'changed', 'next').at(-1)?.messages ?? [];
  expect(() => assertCallConsistency(requests)).toThrow(
    'must retain the preceding request as a prefix',
  );
});

test('order assertions use arrival labels and require both ends', () => {
  const order = [['left#2:response', 'merger#1:request']] as const;
  expect(() => assertOrder(['left#2:response', 'merger#1:request'], order)).not.toThrow();
  expect(() => assertOrder(['merger#1:request', 'left#2:response'], order)).toThrow();
  expect(() => assertOrder(['left#2:response'], order)).toThrow();
});
