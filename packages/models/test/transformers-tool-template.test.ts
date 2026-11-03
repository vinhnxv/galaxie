// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { ModelError } from '../src/errors.js';
import { mapToolMessages } from '../src/transformers/messages.js';
import type { TransformersModelRecord } from '../src/transformers/model-record.js';
import { type GenerateRequest, parseToWorker } from '../src/transformers/protocol.js';
import { templateOptions } from '../src/transformers/runtime.js';
import { renderHermes } from './support/hermes-template.js';

const lookup = {
  type: 'function',
  function: {
    name: 'lookup',
    description: 'Look something up.',
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  },
} as const;

const history = [
  new SystemMessage('Be brief.'),
  new HumanMessage('Find x.'),
  new AIMessage({
    content: 'Looking.',
    tool_calls: [{ id: 'call_0', name: 'lookup', args: { q: 'x' } }],
  }),
  new ToolMessage({ content: 'x is 3', tool_call_id: 'call_0' }),
];

function request(messages: GenerateRequest['messages']): GenerateRequest {
  return { messages, tools: [lookup], maxTokens: 64, temperature: 0 };
}

describe('tool message mapping', () => {
  it('maps assistant calls to object arguments and tool messages to tool turns, in order', () => {
    expect(mapToolMessages(history)).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Find x.' },
      {
        role: 'assistant',
        content: 'Looking.',
        toolCalls: [{ name: 'lookup', arguments: { q: 'x' } }],
      },
      { role: 'tool', content: 'x is 3' },
    ]);
  });

  it('maps an assistant turn with several calls and consecutive tool results in order', () => {
    const mapped = mapToolMessages([
      new HumanMessage('go'),
      new AIMessage({
        content: '',
        tool_calls: [
          { id: 'a', name: 'one', args: {} },
          { id: 'b', name: 'two', args: { v: 1 } },
        ],
      }),
      new ToolMessage({ content: 'first', tool_call_id: 'a' }),
      new ToolMessage({ content: 'second', tool_call_id: 'b' }),
    ]);
    expect(mapped.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'tool']);
    expect(mapped[1]?.toolCalls?.map((call) => call.name)).toEqual(['one', 'two']);
  });

  it.each([
    [
      'a tool turn with no call before it',
      () => [new HumanMessage('hi'), new ToolMessage({ content: 'x', tool_call_id: 'a' })],
    ],
    [
      'more results than calls',
      () => [
        new HumanMessage('go'),
        new AIMessage({ content: '', tool_calls: [{ id: 'a', name: 'one', args: {} }] }),
        new ToolMessage({ content: 'first', tool_call_id: 'a' }),
        new ToolMessage({ content: 'second', tool_call_id: 'b' }),
      ],
    ],
    [
      'a result after a human turn that followed the call',
      () => [
        new HumanMessage('go'),
        new AIMessage({ content: '', tool_calls: [{ id: 'a', name: 'one', args: {} }] }),
        new HumanMessage('wait'),
        new ToolMessage({ content: 'late', tool_call_id: 'a' }),
      ],
    ],
  ])('rejects %s as invalid', (_label, make) => {
    expect(() => mapToolMessages(make())).toThrow(expect.objectContaining({ code: 'invalid' }));
  });

  it('accepts fewer results than calls, as when a result is still pending', () => {
    const mapped = mapToolMessages([
      new HumanMessage('go'),
      new AIMessage({
        content: '',
        tool_calls: [
          { id: 'a', name: 'one', args: {} },
          { id: 'b', name: 'two', args: {} },
        ],
      }),
      new ToolMessage({ content: 'first', tool_call_id: 'a' }),
    ]);
    expect(mapped.map((message) => message.role)).toEqual(['user', 'assistant', 'tool']);
  });

  it('accepts a conversation that ends with a human or a tool turn', () => {
    expect(mapToolMessages(history).at(-1)?.role).toBe('tool');
    expect(mapToolMessages([new HumanMessage('hi')]).at(-1)?.role).toBe('user');
  });

  it.each([
    ['an empty history', () => []],
    ['an assistant turn last', () => [new HumanMessage('hi'), new AIMessage('hello')]],
    [
      'a system message after the first',
      () => [new HumanMessage('hi'), new SystemMessage('late'), new HumanMessage('again')],
    ],
    [
      'an invalid tool call on an assistant turn',
      () => [
        new HumanMessage('hi'),
        new AIMessage({
          content: '',
          invalid_tool_calls: [{ id: 'a', name: 'x', args: '{', error: 'bad' }],
        }),
        new HumanMessage('again'),
      ],
    ],
    [
      'raw provider tool calls',
      () => [
        new HumanMessage('hi'),
        new AIMessage({
          content: '',
          additional_kwargs: {
            tool_calls: [{ id: 'a', type: 'function', function: { name: 'x', arguments: '{}' } }],
          },
        }),
        new HumanMessage('again'),
      ],
    ],
    [
      'a legacy function call',
      () => [
        new HumanMessage('hi'),
        new AIMessage({
          content: '',
          additional_kwargs: { function_call: { name: 'x', arguments: '{}' } },
        }),
        new HumanMessage('again'),
      ],
    ],
    [
      'a non-text content block',
      () => [
        new HumanMessage({
          content: [{ type: 'image_url', image_url: { url: 'https://example.test/a.png' } }],
        }),
      ],
    ],
    [
      'a non-text tool result',
      () => [
        new HumanMessage('hi'),
        new ToolMessage({
          content: [{ type: 'image_url', image_url: { url: 'x' } }],
          tool_call_id: 'a',
        }),
      ],
    ],
  ])('rejects %s as invalid', (_label, make) => {
    expect(() => mapToolMessages(make())).toThrow(ModelError);
    try {
      mapToolMessages(make());
    } catch (error) {
      expect(error).toMatchObject({ code: 'invalid' });
    }
  });

  it('produces a request the Worker protocol accepts', () => {
    const message = {
      type: 'generate',
      id: 1,
      request: request(mapToolMessages(history)),
    };
    expect(parseToWorker(message)).toEqual(message);
  });
});

describe('Hermes-style template rendering', () => {
  it('renders tools, an assistant call and its result without error and in order', () => {
    const rendered = renderHermes(request(mapToolMessages(history)));
    const positions = [
      '<|im_start|>system\nBe brief.',
      '<tools>',
      '"name": "lookup"',
      '<|im_start|>user\nFind x.<|im_end|>',
      '<|im_start|>assistant\nLooking.\n<tool_call>\n{"name": "lookup", "arguments": {"q": "x"}}\n</tool_call><|im_end|>',
      '<|im_start|>user\n<tool_response>\nx is 3\n</tool_response><|im_end|>',
      '<|im_start|>assistant\n',
    ].map((part, index, all) =>
      index === all.length - 1 ? rendered.lastIndexOf(part) : rendered.indexOf(part),
    );
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('groups consecutive tool results into one user turn', () => {
    const rendered = renderHermes(
      request(
        mapToolMessages([
          new HumanMessage('go'),
          new AIMessage({
            content: '',
            tool_calls: [
              { id: 'a', name: 'one', args: {} },
              { id: 'b', name: 'two', args: {} },
            ],
          }),
          new ToolMessage({ content: 'first', tool_call_id: 'a' }),
          new ToolMessage({ content: 'second', tool_call_id: 'b' }),
        ]),
      ),
    );
    expect(rendered).toContain(
      '<|im_start|>user\n<tool_response>\nfirst\n</tool_response>\n<tool_response>\nsecond\n</tool_response><|im_end|>',
    );
    expect(rendered.match(/<tool_call>\n\{/g)).toHaveLength(3);
  });

  it('renders a request without tools as plain turns', () => {
    const rendered = renderHermes({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 8,
      temperature: 0,
    });
    expect(rendered).toBe('<|im_start|>user\nhi<|im_end|>\n<|im_start|>assistant\n');
  });
});

describe('template options', () => {
  const record = { template: { enableThinking: false } } as TransformersModelRecord;
  const plain = {} as TransformersModelRecord;
  const base: GenerateRequest = {
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 8,
    temperature: 0,
  };

  it('turns thinking off only when the record says so and passes tools through', () => {
    expect(templateOptions(base, record)).toEqual({
      enable_thinking: false,
      add_generation_prompt: true,
      return_dict: true,
    });
    expect(templateOptions({ ...base, tools: [lookup] }, plain)).toEqual({
      tools: [lookup],
      add_generation_prompt: true,
      return_dict: true,
    });
  });
});
