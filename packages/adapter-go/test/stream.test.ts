// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { ModelCall } from '@galaxie-ai/core';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, AIMessageChunk, BaseMessage } from '@langchain/core/messages';
import { expect, test, vi } from 'vitest';
import { toolCallChecks } from '../../../tests/conformance/support/tool-call-checks.js';
import { parseModelPayload, validAuthor } from '../src/bridge.js';
import { type ActiveRun, serveModel } from '../src/llm.js';
import {
  carriesCalls,
  closeStream,
  DeltaSplitter,
  emitDelta,
  emitMarker,
  emitPaused,
  MAX_DELTA_LENGTH,
  StreamJoiner,
  type StreamSink,
} from '../src/stream.js';
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

test('10 000 deltas wait at the queue bound and drain without loss or reordering', async () => {
  const sink: StreamSink = { events: [], position: 0, cancelled: false };
  const texts = Array.from({ length: 10_000 }, (_, index) => String(index));
  let finished = false;
  const producing = (async () => {
    for (const text of texts) await emitDelta(sink, 'writer', text);
    finished = true;
  })();
  const turn = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));
  await turn();
  expect(sink.events).toHaveLength(256);
  expect(finished).toBe(false);
  const received: StreamSink['events'] = [];
  while (received.length < texts.length) {
    expect(sink.events.length).toBeLessThanOrEqual(256);
    received.push(...sink.events.splice(0));
    sink.room?.resolve();
    await turn();
  }
  await producing;
  expect(received.map((event) => (event.type === 'stream' ? event.data : undefined))).toEqual(
    texts.map((text) => ({ author: 'writer', text })),
  );
});

test.each(['delta', 'marker'] as const)(
  'closing a full sink releases a waiting %s without pushing it',
  async (kind) => {
    const sink: StreamSink = { events: [], position: 0, cancelled: false };
    for (let index = 0; index < 256; index += 1) await emitDelta(sink, 'writer', 'safe');
    const pending =
      kind === 'delta'
        ? emitDelta(sink, 'writer', 'late')
        : emitMarker(sink, 'tool_call', 'search');
    const stopped = expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(sink.room).toBeDefined();
    closeStream(sink);
    await stopped;
    expect(sink.cancelled).toBe(true);
    expect(sink.events).toHaveLength(256);
    expect(sink.position).toBe(0);
  },
);

test('markers wait for room and keep their indices before the exempt paused marker', async () => {
  const sink: StreamSink = { events: [], position: 7, cancelled: false };
  for (let index = 0; index < 256; index += 1) await emitMarker(sink, 'tool_call', 'search');
  let emitted = false;
  const pending = emitMarker(sink, 'tool_result', 'docs.search@1').then(() => {
    emitted = true;
  });
  await Promise.resolve();
  expect(sink.events).toHaveLength(256);
  expect(emitted).toBe(false);
  const received = sink.events.splice(0);
  sink.room?.resolve();
  await pending;
  for (let index = 0; index < 255; index += 1) await emitMarker(sink, 'tool_call', 'search');
  emitPaused(sink);
  expect(sink.events).toHaveLength(257);
  received.push(...sink.events);
  expect(received.map((event) => (event.type === 'stream' ? event.data : undefined))).toEqual([
    ...Array.from({ length: 256 }, (_, index) => ({
      step: 'tool_call',
      tool: 'search',
      index: index + 7,
    })),
    { step: 'tool_result', tool: 'docs.search@1', index: 263 },
    ...Array.from({ length: 255 }, (_, index) => ({
      step: 'tool_call',
      tool: 'search',
      index: index + 264,
    })),
    { step: 'paused', index: 519 },
  ]);
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

async function checkStream(
  chunks: readonly (AIMessage | AIMessageChunk)[],
  checkOutput: ModelCall['checkOutput'],
): Promise<string> {
  const lease: ModelCall = {
    providerId: 'mock',
    destination: 'in-browser',
    maxTokens: 100,
    outputSafetyOutcome: 'unset',
    checkOutput,
    end() {},
    fail() {},
  };
  const run: ActiveRun = {
    id: 'stream-check',
    request: {
      runId: 'stream-check' as ActiveRun['request']['runId'],
      sessionId: 'stream-session' as ActiveRun['request']['sessionId'],
      command: { type: 'start', input: {} },
      signal: new AbortController().signal,
      trace: { recordsText: false, start: () => ({ end() {} }) },
      capabilities: { call: async () => undefined },
      models: { begin: async () => lease },
      limits: { steps: 10 },
    },
    seen: new Set(),
    leases: new Set(),
    streaming: true,
    modelCalls: 0,
    events: [],
    position: 0,
    cancelled: false,
  };
  const model = {
    bindTools: () => model,
    async *stream() {
      for (const chunk of chunks) {
        run.events.splice(0);
        yield chunk;
      }
    },
  } as unknown as BaseChatModel;
  return serveModel(
    run,
    { chatModels: { mock: model } },
    payload(
      { author: 'writer' },
      {
        stream: true,
        tools: [
          {
            type: 'function',
            function: { name: 'lookup', parameters: { type: 'object', properties: {} } },
          },
        ],
      },
    ),
  );
}

test.each<{ name: string; chunks: (AIMessage | AIMessageChunk)[] }>([
  {
    name: 'text only',
    chunks: [new AIMessageChunk({ content: 'one ' }), new AIMessageChunk({ content: 'two' })],
  },
  {
    name: 'an empty chunk',
    chunks: [
      new AIMessageChunk({ content: 'one' }),
      new AIMessageChunk({ content: '' }),
      new AIMessageChunk({ content: 'two' }),
    ],
  },
  {
    name: 'a split surrogate pair',
    chunks: [
      new AIMessageChunk({ content: 'a\ud83d' }),
      new AIMessageChunk({ content: '\ude00b' }),
    ],
  },
  {
    name: 'text then indexed fragments',
    chunks: [
      new AIMessageChunk({ content: 'looking' }),
      fragment('{"q":', { id: 'indexed', name: 'lookup' }),
      fragment('"abc"}'),
    ],
  },
  {
    name: 'fragments keyed by id',
    chunks: [
      fragment('{"q":1}', { index: undefined, id: 'one', name: 'lookup' }),
      fragment('{"q":2}', { index: undefined, id: 'two', name: 'lookup' }),
    ],
  },
  {
    name: 'position-keyed fragments kept as separate unindexed entries by concatenation',
    chunks: [
      fragment('{"q":', { index: undefined, name: 'lookup' }),
      fragment('"abc"}', { index: undefined }),
    ],
  },
  {
    name: 'a complete call',
    chunks: [
      new AIMessageChunk({ content: 'looking' }),
      new AIMessageChunk({
        content: '',
        tool_calls: [{ id: 'complete', name: 'lookup', args: { q: 'abc' } }],
      }),
      new AIMessageChunk({ content: ' done' }),
    ],
  },
  {
    name: 'an additional kwargs call mirror',
    chunks: [
      new AIMessageChunk({ content: 'looking' }),
      new AIMessageChunk({
        content: '',
        additional_kwargs: {
          tool_calls: [
            {
              id: 'mirror',
              type: 'function',
              function: { name: 'lookup', arguments: '{ "q": "abc" }' },
            },
          ],
        },
      }),
      new AIMessageChunk({ content: ' done' }),
    ],
  },
  {
    name: 'an empty call mirror',
    chunks: [
      new AIMessageChunk({ content: 'one', additional_kwargs: { tool_calls: [] } }),
      new AIMessageChunk({ content: 'two' }),
    ],
  },
  {
    name: 'a repaired argument whose escape sequence completes later',
    chunks: [fragment('{"q":"line\\', { id: 'escape', name: 'lookup' }), fragment('nnext"}')],
  },
  {
    name: 'a provider-reported invalid call',
    chunks: [
      new AIMessageChunk({ content: 'before' }),
      new AIMessage({
        content: '',
        invalid_tool_calls: [
          { name: 'lookup', args: '{', error: 'bad', type: 'invalid_tool_call' },
        ],
      }),
      new AIMessageChunk({ content: 'after' }),
    ],
  },
  {
    name: 'text after a fragment',
    chunks: [
      fragment('{"q":"abc"}', { id: 'before-text', name: 'lookup' }),
      new AIMessageChunk({ content: 'done' }),
    ],
  },
  {
    name: 'a complete call beside fragments',
    chunks: [
      new AIMessageChunk({
        content: '',
        tool_calls: [{ id: 'complete', name: 'lookup', args: { q: 'one' } }],
      }),
      fragment('{"q":"two"}', { id: 'fragment', name: 'lookup' }),
    ],
  },
])('the output hook matches the reference on every chunk: $name', async ({ chunks }) => {
  const reference = new StreamJoiner();
  const expected: [string, { final: boolean }][] = [];
  let failure: unknown;
  try {
    for (const chunk of chunks)
      expected.push([growingText(reference.append(chunk)), { final: false }]);
    reference.finish();
  } catch (error) {
    failure = error;
  }
  const checkOutput = vi.fn<ModelCall['checkOutput']>(async () => {});
  const result = checkStream(chunks, checkOutput);
  if (failure === undefined) await expect(result).resolves.toEqual(expect.any(String));
  else await expect(result).rejects.toMatchObject({ code: Reflect.get(failure as object, 'code') });
  expect(checkOutput.mock.calls.filter(([, options]) => !options.final)).toEqual(expected);
});

test('the check-text builder reads only each chunk for 8 000 text-only chunks', async () => {
  const chunks = Array.from(
    { length: 8000 },
    (_, index) => new AIMessageChunk({ content: `${index % 10} ` }),
  );
  const readText = Object.getOwnPropertyDescriptor(BaseMessage.prototype, 'text')?.get;
  if (readText === undefined) throw new Error('The message text getter is missing');
  let characters = 0;
  const work: number[] = [];
  const text = vi.spyOn(BaseMessage.prototype, 'text', 'get').mockImplementation(function (
    this: BaseMessage,
  ): string {
    const value: string = readText.call(this);
    characters += value.length;
    return value;
  });
  try {
    await checkStream(chunks, async (_checked, { final }) => {
      if (final) return;
      work.push(characters);
      characters = 0;
    });
    expect(work).toEqual(chunks.map((chunk) => (chunk.content as string).length));
  } finally {
    text.mockRestore();
  }
});

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

test('one whole call joins to one call', () => {
  const whole = new AIMessageChunk({
    content: '',
    tool_calls: [{ id: 'a', name: 'lookup', args: { q: 'x' } }],
  });
  expect(join([whole]).tool_calls).toEqual([
    expect.objectContaining({ id: 'a', args: { q: 'x' } }),
  ]);
});

test('two whole calls in one stream are refused as unsupported', () => {
  const whole = (id: string): AIMessageChunk =>
    new AIMessageChunk({ content: '', tool_calls: [{ id, name: 'lookup', args: {} }] });
  expect(() => join([whole('a'), whole('b')])).toThrow(
    expect.objectContaining({ code: 'unsupported' }),
  );
});

test('fragments keyed by id without an index join to separate calls', () => {
  const byId = (id: string, args: string): AIMessageChunk =>
    new AIMessageChunk({
      content: '',
      tool_call_chunks: [{ id, name: 'lookup', args, type: 'tool_call_chunk' }],
    });
  const joined = join([byId('a', '{"q":1}'), byId('b', '{"q":2}')]);
  expect(joined.tool_calls?.map((call) => call.args)).toEqual([{ q: 1 }, { q: 2 }]);
});

test('append returns the reply joined so far', () => {
  const joiner = new StreamJoiner();
  expect(joiner.append(new AIMessageChunk({ content: 'one ' })).content).toBe('one ');
  expect(joiner.append(new AIMessageChunk({ content: 'two' })).content).toBe('one two');
});

test.each([
  ['plain text', new AIMessageChunk({ content: 'hi' }), false],
  [
    'a normalized call',
    new AIMessage({ content: '', tool_calls: [{ id: 'a', name: 'n', args: {} }] }),
    true,
  ],
  ['an argument fragment', fragment('{"q":'), true],
  [
    'a provider mirror',
    new AIMessage({ content: '', additional_kwargs: { tool_calls: [] } }),
    true,
  ],
  [
    'an invalid call',
    new AIMessage({
      content: '',
      invalid_tool_calls: [{ name: 'n', args: '{', error: 'bad', type: 'invalid_tool_call' }],
    }),
    true,
  ],
])('a chunk carrying %s is detected as carrying calls: %s', (_name, chunk, expected) => {
  expect(carriesCalls(chunk)).toBe(expected);
});
