// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { AIMessage, HumanMessage, isAIMessage } from '@langchain/core/messages';
import { expect, test } from 'vitest';
import { toolCallChecks } from '../../../tests/conformance/support/tool-call-checks.js';
import {
  argumentChunks,
  hasArgumentMirror,
  isRecord,
  outputText,
  rawArgumentChunks,
  replyCalls,
  sameJson,
} from '../src/index.js';

test.each(toolCallChecks)(
  'checked text matches the routed model: $name',
  ({ message, checked }) => {
    const reply = new AIMessage(message);
    expect(outputText(reply, isAIMessage(reply))).toBe(checked);
    expect(argumentChunks(reply, true).map((call) => call.args)).toEqual(
      replyCalls(reply, true).map((call) => call.args),
    );
  },
);

function rawKwargs(calls: unknown): AIMessage['additional_kwargs'] {
  return { tool_calls: calls } as AIMessage['additional_kwargs'];
}

test('raw mirrors stay in checked text but can be excluded from executable calls', () => {
  const message = new AIMessage({
    content: '',
    tool_calls: [{ id: 'one', name: 'lookup', args: {} }],
    additional_kwargs: rawKwargs([{ id: 'one', function: { name: 'lookup', arguments: '' } }]),
  });
  expect(outputText(message, true)).toBe('\n{}\n');
  expect(argumentChunks(message, true, false)).toEqual([
    { id: 'one', name: 'lookup', index: 0, args: '{}' },
  ]);
});

test('raw object checks retain the strict default and caller-specific record acceptance', () => {
  const fn = Object.assign(Object.create({}), { name: 'lookup', arguments: '{}' });
  const message = new AIMessage({
    content: '',
    additional_kwargs: rawKwargs([{ function: fn }]),
  });
  expect(rawArgumentChunks(message)).toEqual([]);
  expect(rawArgumentChunks(message, isRecord)).toEqual([{ name: 'lookup', index: 0, args: '{}' }]);
  expect(outputText(new HumanMessage('hello'), false)).toBe('hello');
});

test('complete JSON comparison does not repair truncated arguments', () => {
  expect(sameJson('{ "value": 2 }', { value: 2 })).toBe(true);
  expect(sameJson('{"value":', { value: 2 })).toBe(false);
  expect(sameJson('{}', { value: 2 })).toBe(false);
});

test('raw fragment mirrors match IDs or index/position without hiding other arguments', () => {
  const raw = { index: 1, id: 'one', name: 'lookup', args: '{"value":' };
  expect(hasArgumentMirror(raw, [{ id: 'one', args: raw.args }])).toBe(true);
  expect(hasArgumentMirror(raw, [{ index: 1, args: raw.args }])).toBe(true);
  expect(hasArgumentMirror(raw, [{ index: 1, args: '{}' }])).toBe(false);
  expect(hasArgumentMirror(raw, [{ index: 1, id: 'two', args: raw.args }])).toBe(false);
  expect(hasArgumentMirror(raw, [{ index: 1, name: 'other', args: raw.args }])).toBe(false);
});
