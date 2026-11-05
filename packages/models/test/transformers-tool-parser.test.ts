// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import {
  foldItems,
  maxToolBlocks,
  parseToolBlocks,
  ToolBlockSplitter,
  type ToolItem,
} from '../src/transformers/tool-parser.js';

const block = (body: string): string => `<tool_call>${body}</tool_call>`;
const call = (name: string, args: unknown): string =>
  block(JSON.stringify({ name, arguments: args }));

function splitIn(reply: string, sizes: readonly number[]): ToolItem[] {
  const splitter = new ToolBlockSplitter();
  const items: ToolItem[] = [];
  let offset = 0;
  for (let step = 0; offset < reply.length; step++) {
    const size = sizes[step % sizes.length] ?? 1;
    items.push(...splitter.push(reply.slice(offset, offset + size)));
    offset += size;
  }
  items.push(...splitter.finish());
  return items;
}

/** A small deterministic generator so the random chunkings are reproducible. */
function sequence(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state;
  };
}

describe('parseToolBlocks', () => {
  it('parses one valid block into one call with parsed arguments and ID call_0', () => {
    const reply = parseToolBlocks(call('lookup', { q: 'x', n: 2 }));
    expect(reply.text).toBe('');
    expect(reply.invalid).toEqual([]);
    expect(reply.calls).toEqual([
      { kind: 'call', index: 0, id: 'call_0', name: 'lookup', args: { q: 'x', n: 2 } },
    ]);
  });

  it('numbers blocks in reply order and trims the text at the seams', () => {
    const reply = parseToolBlocks(
      `Let me check.  \n${call('a', {})}\n\n  ${call('b', { v: 1 })}  \nDone. `,
    );
    expect(reply.text).toBe('Let me check.Done. ');
    expect(reply.calls.map((item) => [item.id, item.name, item.args])).toEqual([
      ['call_0', 'a', {}],
      ['call_1', 'b', { v: 1 }],
    ]);
  });

  it('keeps leading whitespace at the start and trailing whitespace at the end of a reply', () => {
    expect(parseToolBlocks('  hello  ').text).toBe('  hello  ');
    expect(parseToolBlocks('   ').text).toBe('   ');
    expect(parseToolBlocks(`${call('a', {})}   `).text).toBe('');
  });

  it('treats a call without arguments as a call with none', () => {
    expect(parseToolBlocks(block('{"name":"ping"}')).calls[0]?.args).toEqual({});
  });

  it.each([
    ['invalid JSON', block('{"name": "a", "arguments": {')],
    ['a non-string name', block('{"name": 3, "arguments": {}}')],
    ['an empty name', block('{"name": "", "arguments": {}}')],
    ['array arguments', block('{"name": "a", "arguments": [1]}')],
    ['string arguments', block('{"name": "a", "arguments": "{}"}')],
    ['a JSON array', block('[1, 2]')],
    ['a missing name', block('{"arguments": {}}')],
    ['an empty block', block('')],
  ])('turns %s into an invalid call that keeps the raw block text', (_label, reply) => {
    const parsed = parseToolBlocks(reply);
    expect(parsed.calls).toEqual([]);
    expect(parsed.invalid).toHaveLength(1);
    expect(parsed.invalid[0]?.args).toBe(reply.slice('<tool_call>'.length, -'</tool_call>'.length));
    expect(parsed.invalid[0]?.id).toBe('call_0');
  });

  it('keeps a usable name on an invalid call whose arguments are wrong', () => {
    const parsed = parseToolBlocks(block('{"name": "a", "arguments": [1]}'));
    expect(parsed.invalid[0]?.name).toBe('a');
  });

  it('turns a stray closing tag into an invalid call and keeps the surrounding text', () => {
    const parsed = parseToolBlocks('before </tool_call> after');
    expect(parsed.text).toBe('beforeafter');
    expect(parsed.invalid).toEqual([
      { kind: 'invalid', index: 0, id: 'call_0', args: '</tool_call>' },
    ]);
  });

  it('turns an unterminated block at the end into an invalid call, never reply text', () => {
    const parsed = parseToolBlocks('go <tool_call>{"name": "a", "arguments": {"x"');
    expect(parsed.text).toBe('go');
    expect(parsed.calls).toEqual([]);
    expect(parsed.invalid[0]?.args).toBe('{"name": "a", "arguments": {"x"');
  });

  it('turns a nested opening tag into an invalid call that keeps both tags', () => {
    const parsed = parseToolBlocks(`<tool_call>${call('a', {})}`);
    expect(parsed.calls).toEqual([]);
    expect(parsed.invalid[0]?.args).toBe('<tool_call>{"name":"a","arguments":{}}');
  });

  it('accepts sixteen blocks and turns the seventeenth into an invalid call', () => {
    const reply = Array.from({ length: maxToolBlocks + 1 }, (_, index) =>
      call('a', { n: index }),
    ).join('');
    const parsed = parseToolBlocks(reply);
    expect(parsed.calls).toHaveLength(maxToolBlocks);
    expect(parsed.invalid).toHaveLength(1);
    expect(parsed.invalid[0]).toMatchObject({
      index: maxToolBlocks,
      id: `call_${maxToolBlocks}`,
      args: '{"name":"a","arguments":{"n":16}}',
    });
  });

  it('numbers invalid blocks in the same sequence as valid ones', () => {
    const parsed = parseToolBlocks(`${call('a', {})}${block('nope')}${call('b', {})}`);
    expect(parsed.calls.map((item) => item.id)).toEqual(['call_0', 'call_2']);
    expect(parsed.invalid.map((item) => item.id)).toEqual(['call_1']);
  });
});

describe('ToolBlockSplitter', () => {
  const replies = [
    'plain text only',
    '  leading and trailing  ',
    call('a', { x: 1 }),
    `Sure.\n${call('a', { x: 1 })}`,
    `  ${call('a', {})}\n \t ${call('b', { y: [1, 2] })}\n  `,
    `Before ${call('a', {})} middle ${call('b', {})} after`,
    `x < y and a <tool b> and </tool and <tool_call  ${call('a', {})}`,
    `${block('bad json')} text ${call('ok', {})} </tool_call> tail`,
    `go <tool_call>{"name":"a","arguments":{"s":"</tool"}}</tool_call>`,
    `unterminated <tool_call>{"name": "a"`,
    ' ',
    '',
    `<tool_call${'>'}${call('a', {})}`,
  ];

  it('gives the same text and calls as the one-shot parse for one character at a time', () => {
    for (const reply of replies)
      expect(foldItems(splitIn(reply, [1])), reply).toEqual(parseToolBlocks(reply));
  });

  it('gives the same text and calls for random chunk sizes', () => {
    const next = sequence(7);
    for (const reply of replies)
      for (let attempt = 0; attempt < 40; attempt++) {
        const sizes = Array.from({ length: 6 }, () => 1 + (next() % 9));
        expect(foldItems(splitIn(reply, sizes)), `${reply} ${sizes}`).toEqual(
          parseToolBlocks(reply),
        );
      }
  });

  it('holds back a lone opening angle bracket and releases it as text when the tag breaks', () => {
    const splitter = new ToolBlockSplitter();
    expect(splitter.push('a <')).toEqual([{ kind: 'text', text: 'a' }]);
    expect(splitter.push('b')).toEqual([{ kind: 'text', text: ' <b' }]);
    expect(splitter.finish()).toEqual([]);
  });

  it('holds back a partial opening tag across chunks and then buffers the block', () => {
    const splitter = new ToolBlockSplitter();
    expect(splitter.push('hi <tool_')).toEqual([{ kind: 'text', text: 'hi' }]);
    expect(splitter.push('call>{"name":"a",')).toEqual([]);
    expect(splitter.push('"arguments":{}}</tool')).toEqual([]);
    expect(splitter.push('_call>')).toEqual([
      { kind: 'call', index: 0, id: 'call_0', name: 'a', args: {} },
    ]);
    expect(splitter.finish()).toEqual([]);
  });

  it('streams no text for a reply that is only a block', () => {
    const items = splitIn(call('a', { x: 1 }), [1]);
    expect(items.some((item) => item.kind === 'text')).toBe(false);
    expect(items).toHaveLength(1);
  });

  it('streams the text before a block first and holds the trailing whitespace', () => {
    const splitter = new ToolBlockSplitter();
    expect(splitter.push('Let me look. ')).toEqual([{ kind: 'text', text: 'Let me look.' }]);
    expect(splitter.push('<tool_call>{"name":"a","arguments":{}}')).toEqual([]);
    expect(splitter.push('</tool_call>')).toEqual([
      { kind: 'call', index: 0, id: 'call_0', name: 'a', args: {} },
    ]);
  });

  it('drops whitespace-only runs beside a block, even when they arrive one character at a time', () => {
    const items = splitIn(` \n${call('a', {})} \n `, [1]);
    // The run before the block and the run after it are both seams, so no text item appears.
    expect(items.map((item) => item.kind)).toEqual(['call']);
  });
});
