// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { AIMessage, StandardMessageStructure } from '@langchain/core/messages';

export const toolCallChecks: readonly {
  readonly name: string;
  readonly message: ConstructorParameters<typeof AIMessage<StandardMessageStructure>>[0];
  readonly checked: string;
}[] = [
  { name: 'text', message: { content: 'hello' }, checked: 'hello' },
  {
    name: 'two calls',
    message: {
      content: 'hello',
      tool_calls: [
        { id: 'one', name: 'lookup', args: { value: 2 } },
        { id: 'two', name: 'lookup', args: { value: 3 } },
      ],
    },
    checked: 'hello\n{"value":2}\n{"value":3}',
  },
  {
    name: 'invalid arguments',
    message: {
      content: '',
      invalid_tool_calls: [{ id: 'one', name: 'lookup', args: '{"value":' }],
    },
    checked: '\n{"value":',
  },
  {
    name: 'raw arguments',
    message: {
      content: '',
      additional_kwargs: {
        tool_calls: [
          {
            id: 'one',
            type: 'function',
            function: { name: 'lookup', arguments: '{ "value": 2 }' },
          },
        ],
      },
    },
    checked: '\n{"value":2}',
  },
  {
    name: 'raw and normalized mirrors',
    message: {
      content: '',
      tool_calls: [{ id: 'one', name: 'lookup', args: { value: 2 } }],
      additional_kwargs: {
        tool_calls: [
          {
            id: 'one',
            type: 'function',
            function: { name: 'lookup', arguments: '{ "value": 2 }' },
          },
        ],
      },
    },
    checked: '\n{"value":2}',
  },
];
