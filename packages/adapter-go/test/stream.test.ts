// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { AIMessage, AIMessageChunk } from '@langchain/core/messages';
import { expect, test } from 'vitest';
import { toolCallChecks } from '../../../tests/conformance/support/tool-call-checks.js';
import { parseModelPayload, validAuthor } from '../src/bridge.js';
import { DeltaSplitter, MAX_DELTA_LENGTH, StreamJoiner } from '../src/stream.js';
import { growingText, outputText, replyCalls } from '../src/tool-calls.js';

const base = {
  role: 'answer',
  messages: [{ role: 'user', content: 'hi' }],
};
const payload = (extra: Record<string, unknown>, options: Record<string, unknown> = {}): string =>
  JSON.stringify({ ...base, options, ...extra });

test.each([
  ['a plain request', payload({}), true],
  ['a streamed request with an author', payload({ author: 'writer' }, { stream: true }), true],
  [
    'an author with a space and punctuation',
    payload({ author: 'a b-c.d' }, { stream: true }),
    true,
  ],
  ['a stream without an author', payload({}, { stream: true }), false],
  ['an author without a stream', payload({ author: 'writer' }), false],
  ['an author with stream false', payload({ author: 'writer' }, { stream: false }), false],
  ['an empty author', payload({ author: '' }, { stream: true }), false],
  ['an author over the bound', payload({ author: 'a'.repeat(129) }, { stream: true }), false],
  ['an author at the bound', payload({ author: 'a'.repeat(128) }, { stream: true }), true],
  ['an author with a control character', payload({ author: 'a\nb' }, { stream: true }), false],
  ['a numeric author', payload({ author: 7 }, { stream: true }), false],
  ['a non-boolean stream', payload({ author: 'writer' }, { stream: 'yes' }), false],
  ['an unknown top-level key', payload({ extra: 1 }), false],
  ['an unknown option', payload({}, { temperature: 1 }), false],
])('model payload: %s', (_name, text, accepted) => {
  if (accepted) expect(() => parseModelPayload(text)).not.toThrow();
  else expect(() => parseModelPayload(text)).toThrow(expect.objectContaining({ code: 'invalid' }));
});

test('author validation accepts only bounded printable text', () => {
  expect(validAuthor('writer')).toBe(true);
  expect(validAuthor('')).toBe(false);
  expect(validAuthor(undefined)).toBe(false);
  expect(validAuthor('tab\there')).toBe(false);
});

test('the splitter passes short text through and drops nothing', () => {
  const splitter = new DeltaSplitter();
  expect(splitter.feed('')).toEqual([]);
  expect(splitter.feed('one ')).toEqual(['one ']);
  expect(splitter.feed('two')).toEqual(['two']);
});

test('the splitter cuts long text at the bound', () => {
  const text = 'x'.repeat(MAX_DELTA_LENGTH * 2 + 5);
  const pieces = new DeltaSplitter().feed(text);
  expect(pieces.map((piece) => piece.length)).toEqual([MAX_DELTA_LENGTH, MAX_DELTA_LENGTH, 5]);
  expect(pieces.join('')).toBe(text);
});

test('the splitter never cuts a surrogate pair at the bound', () => {
  const text = `${'a'.repeat(MAX_DELTA_LENGTH - 1)}\u{1F600}tail`;
  const pieces = new DeltaSplitter().feed(text);
  expect(pieces[0]).toBe('a'.repeat(MAX_DELTA_LENGTH - 1));
  expect(pieces.join('')).toBe(text);
  for (const piece of pieces) expect(piece).toBe(piece.toWellFormed());
});

test('the splitter holds a high surrogate that ends a chunk until the pair completes', () => {
  const pair = '\u{1F600}';
  const splitter = new DeltaSplitter();
  expect(splitter.feed(`ab${pair[0]}`)).toEqual(['ab']);
  expect(splitter.feed(`${pair[1]}cd`)).toEqual([`${pair}cd`]);
  // A lone high surrogate with nothing after it is not emitted as half a character.
  expect(splitter.feed(pair[0] as string)).toEqual([]);
});

test.each(toolCallChecks)(
  'checked text matches the routed model: $name',
  ({ message, checked }) => {
    expect(outputText(new AIMessage(message))).toBe(checked);
  },
);

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

test('the growing text carries raw argument fragments before any call parses', () => {
  const chunk = new AIMessageChunk({
    content: 'so far',
    tool_call_chunks: [{ index: 0, args: '{"canary":"ab', type: 'tool_call_chunk' }],
  });
  expect(growingText(chunk)).toContain('{"canary":"ab');
  expect(growingText(chunk).startsWith('so far')).toBe(true);
});

const fragment = (args: string, extra: Record<string, unknown> = {}): AIMessageChunk =>
  new AIMessageChunk({
    content: '',
    tool_call_chunks: [{ index: 0, args, type: 'tool_call_chunk', ...extra }],
  });

function join(chunks: (AIMessage | AIMessageChunk)[]): AIMessage | AIMessageChunk {
  const joiner = new StreamJoiner();
  for (const chunk of chunks) joiner.append(chunk);
  return joiner.finish();
}

test('text chunks join to the full text', () => {
  const joined = join([
    new AIMessageChunk({ content: 'one ' }),
    new AIMessageChunk({ content: 'two' }),
  ]);
  expect(joined.content).toBe('one two');
  expect(joined.tool_calls ?? []).toEqual([]);
});

test('argument fragments that join to complete JSON become one call', () => {
  const joined = join([fragment('{"q":', { name: 'lookup', id: 'c1' }), fragment('"abc"}')]);
  expect(joined.tool_calls).toEqual([
    expect.objectContaining({ id: 'c1', name: 'lookup', args: { q: 'abc' } }),
  ]);
});

test('a stream cut off inside call arguments fails invalid instead of using repaired arguments', () => {
  expect(() => join([fragment('{"q":"ab', { name: 'lookup', id: 'c1' })])).toThrow(
    expect.objectContaining({ code: 'invalid' }),
  );
});

test('empty arguments are an empty object', () => {
  const joined = join([fragment('', { name: 'lookup', id: 'c1' })]);
  expect(joined.tool_calls).toEqual([expect.objectContaining({ name: 'lookup', args: {} })]);
});

test('a complete call beside argument fragments is refused as unsupported', () => {
  const whole = new AIMessageChunk({
    content: '',
    tool_calls: [{ id: 'a', name: 'lookup', args: { q: 'x' } }],
  });
  expect(() => join([whole, fragment('{"q":"y"}', { name: 'lookup', id: 'c1' })])).toThrow(
    expect.objectContaining({ code: 'unsupported' }),
  );
});

test('a provider-reported invalid call chunk is refused as invalid', () => {
  // A provider without native streaming yields its whole reply, which can report an invalid call.
  const invalid = new AIMessage({
    content: '',
    invalid_tool_calls: [{ name: 'lookup', args: '{', error: 'bad', type: 'invalid_tool_call' }],
  });
  expect(() => join([invalid])).toThrow(expect.objectContaining({ code: 'invalid' }));
});

test('an empty provider stream fails unavailable', () => {
  expect(() => join([])).toThrow(expect.objectContaining({ code: 'unavailable' }));
});
