// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

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
