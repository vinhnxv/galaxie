// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { AIMessage, AIMessageChunk } from '@langchain/core/messages';
import { expect, test } from 'vitest';
import { toolCallChecks } from '../../../tests/conformance/support/tool-call-checks.js';
import { GrowingOutput, outputText, toolCalls } from '../src/tool-calls.js';

test.each(toolCallChecks)(
  'checked text matches the routed model: $name',
  ({ message, checked }) => {
    expect(outputText(new AIMessage(message))).toBe(checked);
  },
);

test('argument fragments grow by call index without hiding complete calls', () => {
  const growing = new GrowingOutput();
  expect(
    growing.append(
      new AIMessageChunk({
        content: 'reply',
        tool_call_chunks: [
          { index: 0, id: 'one', name: 'lookup', args: '{"value":"blo' },
          { index: 1, id: 'two', name: 'lookup', args: '{"other":' },
        ],
      }),
    ),
  ).toBe('reply\n{"value":"blo\n{"other":');
  expect(
    growing.append(
      new AIMessageChunk({
        content: '',
        tool_call_chunks: [
          { index: 1, args: '2}' },
          { index: 0, args: 'cked"}' },
        ],
      }),
    ),
  ).toBe('reply\n{"value":"blocked"}\n{"other":2}');
});

test('Python receives parsed calls only, while raw mirrors stay in the checked text', () => {
  const message = new AIMessage({
    content: '',
    tool_calls: [{ id: 'one', name: 'lookup', args: {} }],
    additional_kwargs: {
      tool_calls: [{ id: 'one', type: 'function', function: { name: 'lookup', arguments: '' } }],
    },
  });
  expect(toolCalls(message)).toEqual([
    { id: 'one', type: 'function', function: { name: 'lookup', arguments: '{}' } },
  ]);
  expect(outputText(message)).toBe('\n{}\n');
});

test('parallel streamed calls without an index keep separate slots', () => {
  const growing = new GrowingOutput();
  growing.append(
    new AIMessageChunk({
      content: '',
      tool_call_chunks: [{ id: 'one', name: 'lookup', args: '{"value":1}' }],
    }),
  );
  expect(growing.deltas()).toMatchObject([{ index: 0, id: 'one' }]);
  growing.append(
    new AIMessageChunk({
      content: '',
      tool_call_chunks: [{ id: 'two', name: 'lookup', args: '{"value":2}' }],
    }),
  );
  expect(growing.deltas()).toMatchObject([{ index: 1, id: 'two' }]);
  growing.append(new AIMessageChunk({ content: '', tool_call_chunks: [{ args: '' }] }));
  expect(growing.deltas()).toMatchObject([{ index: 1 }]);
  expect(growing.toolCallIds()).toEqual(['one', 'two']);
  expect(growing.toolCallNames()).toEqual(['lookup', 'lookup']);
});
