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
import renderings from './fixtures/onnx-tool-renderings.json' with { type: 'json' };

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

const xmlTools = [
  {
    type: 'function',
    function: {
      name: 'lookup',
      parameters: {
        type: 'object',
        properties: {
          q: { type: 'string' },
          limit: { type: 'integer' },
          score: { type: 'number' },
          enabled: { type: 'boolean' },
          uncertain: { type: ['integer', 'string'] },
          object: { type: 'object' },
        },
      },
    },
  },
];
const xmlBody =
  '<function=lookup><parameter=q>x</parameter><parameter=limit>2</parameter></function>';
const xml = block(xmlBody);
const parseXml = (text: string) => parseToolBlocks(text, 'xml', xmlTools);

describe('XML tool blocks', () => {
  it('parses two parameters, using only their declared types, and numbers calls in order', () => {
    const parsed = parseXml(`${xml}\n${xml.replace('>x<', '>2<')}`);
    expect(parsed.text).toBe('');
    expect(parsed.invalid).toEqual([]);
    expect(parsed.calls).toEqual([
      { kind: 'call', index: 0, id: 'call_0', name: 'lookup', args: { q: 'x', limit: 2 } },
      { kind: 'call', index: 1, id: 'call_1', name: 'lookup', args: { q: '2', limit: 2 } },
    ]);
  });

  it.each([
    ['limit', '2', 2],
    ['limit', '2.5', '2.5'],
    ['limit', '02', '02'],
    ['limit', '9007199254740993', '9007199254740993'],
    ['score', '0.25', 0.25],
    ['score', '0.10000000000000001', '0.10000000000000001'],
    ['score', '1.0', '1.0'],
    ['score', '1e3', '1e3'],
    ['score', '-0', '-0'],
    ['score', 'Infinity', 'Infinity'],
    ['enabled', 'true', true],
    ['enabled', 'false', false],
    ['enabled', 'True', 'True'],
    ['enabled', '1', '1'],
    ['q', '2', '2'],
    ['uncertain', '2', '2'],
    ['undeclared', '2', '2'],
    ['object', '{"x":2}', '{"x":2}'],
  ])('converts %s=%s only on an exact schema-directed round trip', (name, value, expected) => {
    const reply = block(`<function=lookup><parameter=${name}> ${value} </parameter></function>`);
    expect(parseXml(reply).calls[0]?.args).toEqual({ [name]: expected });
  });

  it('keeps values as strings without a matching declaration', () => {
    expect(parseToolBlocks(xml, 'xml').calls[0]?.args).toEqual({ q: 'x', limit: '2' });
    expect(parseXml(xml.replace('function=lookup', 'function=unknown')).calls[0]?.args).toEqual({
      q: 'x',
      limit: '2',
    });
  });

  it('tolerates indentation and newlines between tags and trims values', () => {
    const reply = `<tool_call>\n  <function=lookup>\n    <parameter=q>\n      x\n    </parameter>\n    <parameter=limit>\n      2\n    </parameter>\n  </function>\n</tool_call>`;
    expect(parseXml(reply)).toEqual(parseXml(xml));
  });

  it.each([
    ['no function name', block('<function=><parameter=q>x</parameter></function>')],
    ['nested functions', block('<function=lookup><function=other></function></function>')],
    [
      'nested function in a value',
      block('<function=lookup><parameter=q><function=other></function></parameter></function>'),
    ],
    [
      'duplicate parameters',
      block('<function=lookup><parameter=q>x</parameter><parameter=q>y</parameter></function>'),
    ],
    ['missing parameter close', block('<function=lookup><parameter=q>x</function>')],
    ['extra text', block(`${xmlBody}extra`)],
    ['no closing tag', `<tool_call>${xmlBody}`],
  ])('keeps the raw body of %s as an invalid call', (_label, reply) => {
    const parsed = parseXml(reply);
    expect(parsed.calls).toEqual([]);
    expect(parsed.text).toBe('');
    expect(parsed.invalid).toEqual([
      expect.objectContaining({
        id: 'call_0',
        args: reply.slice('<tool_call>'.length).replace(/<\/tool_call>$/, ''),
      }),
    ]);
  });

  it('accepts sixteen blocks and keeps the seventeenth raw', () => {
    const parsed = parseXml(xml.repeat(maxToolBlocks + 1));
    expect(parsed.calls).toHaveLength(16);
    expect(parsed.invalid).toEqual([{ kind: 'invalid', index: 16, id: 'call_16', args: xmlBody }]);
  });

  it('keeps prototype-shaped parameter names as ordinary own data', () => {
    const parsed = parseXml(
      block('<function=lookup><parameter=__proto__>x</parameter></function>'),
    );
    expect(Object.hasOwn(parsed.calls[0]?.args ?? {}, '__proto__')).toBe(true);
    expect(JSON.stringify(parsed.calls[0]?.args)).toBe('{"__proto__":"x"}');
  });

  it.each(renderings)('parses the assistant rendering from $repository', ({ rendered }) => {
    const start = rendered.lastIndexOf('<tool_call>');
    const reply = rendered.slice(
      start,
      rendered.indexOf('</tool_call>', start) + '</tool_call>'.length,
    );
    expect(parseXml(reply).calls).toEqual([
      {
        kind: 'call',
        index: 0,
        id: 'call_0',
        name: 'lookup',
        args: { q: 'browser notes', limit: 2 },
      },
    ]);
    expect(parseXml(reply).invalid).toEqual([]);
  });

  it('holds markup back, emits a complete block once, and streams surrounding text', () => {
    const splitter = new ToolBlockSplitter('xml', xmlTools);
    expect(splitter.push('Before <tool_')).toEqual([{ kind: 'text', text: 'Before' }]);
    expect(splitter.push(`call>${xmlBody}</tool_`)).toEqual([]);
    expect(splitter.push('call> After')).toEqual([
      { kind: 'call', index: 0, id: 'call_0', name: 'lookup', args: { q: 'x', limit: 2 } },
      { kind: 'text', text: 'After' },
    ]);
    expect(splitter.finish()).toEqual([]);
  });

  it('matches the complete parse across single-character and random chunk boundaries', () => {
    const next = sequence(19);
    for (const reply of [
      xml,
      `Before \n${xml}\n After`,
      xml.repeat(17),
      `<tool_call>${xmlBody}`,
      block('<function=>'),
    ]) {
      for (let attempt = 0; attempt < 20; attempt++) {
        const splitter = new ToolBlockSplitter('xml', xmlTools);
        const items: ToolItem[] = [];
        let offset = 0;
        while (offset < reply.length) {
          const size = attempt === 0 ? 1 : 1 + (next() % 13);
          items.push(...splitter.push(reply.slice(offset, offset + size)));
          offset += size;
        }
        items.push(...splitter.finish());
        expect(foldItems(items)).toEqual(parseXml(reply));
      }
    }
  });
});
