// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { AIMessage } from '@langchain/core/messages';
import { expect, test } from 'vitest';
import { toolCallChecks } from '../../../tests/conformance/support/tool-call-checks.js';
import { checkedText, outputText, replyCalls } from '../src/tool-calls.js';

test.each(toolCallChecks)(
  'checked text matches the routed model: $name',
  ({ message, checked }) => {
    expect(outputText(new AIMessage(message))).toBe(checked);
  },
);

test('call IDs and names are checked as separate strings after the shared text', () => {
  const message = new AIMessage({
    content: 'hello',
    tool_calls: [{ id: 'call-id', name: 'lookup', args: { value: 2 } }],
  });
  expect(checkedText(message)).toBe('hello\n{"value":2}\ncall-id\nlookup');
});

test('a canary in a call ID, name or argument reaches the checked text', () => {
  for (const [id, name, args] of [
    ['canary', 'lookup', {}],
    ['call', 'canary', {}],
    ['call', 'lookup', { value: 'canary' }],
  ] as const) {
    const message = new AIMessage({ content: '', tool_calls: [{ id, name, args }] });
    expect(checkedText(message)).toContain('canary');
  }
});

test('raw provider mirrors of a normalized call are not counted twice', () => {
  const message = new AIMessage({
    content: '',
    tool_calls: [{ id: 'one', name: 'lookup', args: { value: 2 } }],
    additional_kwargs: {
      tool_calls: [
        { id: 'one', type: 'function', function: { name: 'lookup', arguments: '{ "value": 2 }' } },
      ],
    },
  });
  expect(replyCalls(message)).toHaveLength(1);
});
