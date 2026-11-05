// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { expect, test } from 'vitest';
import { createMockLatch, MockChatModel, MockModelError, type MockScript } from '../src/mock.js';

const usage = { input_tokens: 2, output_tokens: 3, total_tokens: 5 };
test('invoke returns scripted text and usage and counts calls', async () => {
  const model = new MockChatModel({ hello: { id: 'reply', text: 'hello world', usage } });
  const reply = await model.invoke([new HumanMessage('hello')]);
  expect(reply.content).toBe('hello world');
  expect(reply.usage_metadata).toEqual(usage);
  expect(model.calls).toBe(1);
  await model.invoke('hello');
  expect(model.calls).toBe(2);
});
test('stream yields words in order and usage only on the final chunk', async () => {
  const model = new MockChatModel({ hello: { id: 'reply', text: 'hello world', usage } });
  const chunks = [];
  for await (const chunk of await model.stream('hello')) chunks.push(chunk);
  expect(chunks.map((chunk) => chunk.content)).toEqual(['hello ', 'world']);
  expect(chunks.map((chunk) => chunk.usage_metadata)).toEqual([undefined, usage]);
  expect(model.calls).toBe(1);
});
test('usage is omitted when the script has no usage', async () => {
  const model = new MockChatModel({ hello: { id: 'reply', text: 'ok' } });
  expect((await model.invoke('hello')).usage_metadata).toBeUndefined();
  for await (const chunk of await model.stream('hello'))
    expect(chunk.usage_metadata).toBeUndefined();
});
test('unknown messages produce a typed fixed error without echoing the input', async () => {
  const model = new MockChatModel({});
  await expect(model.invoke('private-canary')).rejects.toBeInstanceOf(MockModelError);
  await expect(model.invoke('private-canary')).rejects.toMatchObject({
    message: 'The mock has no script for this human message.',
  });
});
test('scripted failures preserve their error object', async () => {
  const error = new Error('scripted');
  const model = new MockChatModel({ fail: { error } });
  await expect(model.invoke('fail')).rejects.toBe(error);
  expect(model.calls).toBe(1);
});
test('aborting a latch rejects with the abort reason', async () => {
  const wait = createMockLatch();
  const reason = new Error('stop');
  const controller = new AbortController();
  const model = new MockChatModel({ hello: { id: 'reply', text: 'ok', wait } });
  const pending = model.invoke('hello', { signal: controller.signal });
  const rejected = expect(pending).rejects.toBe(reason);
  await wait.entered;
  controller.abort(reason);
  await rejected;
  wait.release();
});
test('metadata uses configured names and the last human message selects the reply', async () => {
  const model = new MockChatModel(
    { last: { id: 'reply', text: 'ok' } },
    { provider: 'test-provider', model: 'test-model' },
  );
  expect(model.getLsParams()).toEqual({
    ls_model_type: 'chat',
    ls_provider: 'test-provider',
    ls_model_name: 'test-model',
  });
  expect((await model.invoke([new HumanMessage('first'), new HumanMessage('last')])).content).toBe(
    'ok',
  );
  expect(new MockChatModel({}).getLsParams()).toEqual({
    ls_model_type: 'chat',
    ls_provider: 'galaxie-mock',
    ls_model_name: 'mock-1',
  });
});

const tools = [{ type: 'function', function: { name: 'double', parameters: { type: 'object' } } }];
const toolCalls = [{ id: 'call-1', name: 'double', args: { value: 3 } }];
const sequence: MockScript = {
  calculate: [
    { id: 'tool-reply', text: '', toolCalls },
    { id: 'text-reply', text: 'Six.' },
  ],
};

test('tool sequences advance from conversation history and survive a fresh model', async () => {
  const original = new MockChatModel(sequence);
  const model = original.bindTools(tools);
  const first = await model.invoke('calculate');
  expect(first.tool_calls).toEqual(toolCalls);
  expect(first.content).toBe('');
  const history = [
    new HumanMessage('calculate'),
    first,
    new ToolMessage({ content: '6', tool_call_id: 'call-1' }),
  ];
  expect((await model.invoke(history)).content).toBe('Six.');
  expect((await new MockChatModel(sequence).bindTools(tools).invoke(history)).content).toBe('Six.');
  expect((await model.invoke('calculate')).tool_calls).toEqual(toolCalls);
  expect(original.calls).toBe(3);
});

test('only assistant tool-call turns after the last human advance a sequence', async () => {
  const model = new MockChatModel(sequence).bindTools(tools);
  const reply = await model.invoke([
    new HumanMessage('previous'),
    new AIMessage({ content: '', tool_calls: toolCalls }),
    new HumanMessage('calculate'),
    new AIMessage('some text'),
  ]);
  expect(reply.tool_calls).toEqual(toolCalls);
});

test('assistant-turn sequences script text retries from history across fresh and bound models', async () => {
  const script: MockScript = {
    'Return a number.': [
      { id: 'invalid', text: 'not JSON' },
      { id: 'corrected', text: '{"value":6}' },
    ],
    'Another question.': [{ id: 'another', text: 'New answer.' }],
  };
  const options = { sequence: 'assistant-turns' as const };
  const model = new MockChatModel(script, options);
  const first = await model.invoke('Return a number.');
  expect(first.content).toBe('not JSON');
  const history = [
    new HumanMessage('Return a number.'),
    first,
    new HumanMessage('Invalid JSON: please return a JSON object.'),
  ];
  expect((await model.invoke(history)).content).toBe('{"value":6}');
  const fresh = new MockChatModel(script, options).bindTools(tools);
  const chunks = [];
  for await (const chunk of await fresh.stream(history)) chunks.push(chunk.content);
  expect(chunks.join('')).toBe('{"value":6}');
  expect((await fresh.invoke([...history, new HumanMessage('Another question.')])).content).toBe(
    'New answer.',
  );
  expect((await fresh.invoke('Return a number.')).content).toBe('not JSON');
});

test('streamed argument fragments reassemble with tool identity and final-only usage', async () => {
  const model = new MockChatModel({
    calculate: { id: 'tool-reply', text: '', toolCalls, usage },
  }).bindTools(tools);
  const chunks = [];
  for await (const chunk of await model.stream('calculate')) chunks.push(chunk);
  expect(chunks.length).toBeGreaterThan(1);
  const joined = chunks.reduce((left, right) => left.concat(right));
  expect(joined.tool_calls).toMatchObject(toolCalls);
  expect(
    chunks
      .flatMap((chunk) => chunk.tool_call_chunks ?? [])
      .map((chunk) => chunk.args)
      .join(''),
  ).toBe('{"value":3}');
  expect(chunks.slice(0, -1).every((chunk) => chunk.usage_metadata === undefined)).toBe(true);
  expect(chunks.at(-1)?.usage_metadata).toEqual(usage);
});

test('a bound copy rejects unoffered tools without changing the original binding', async () => {
  const original = new MockChatModel(sequence);
  const bound = original.bindTools(tools);
  const unoffered = original.bindTools([
    { type: 'function', function: { name: 'other', parameters: { type: 'object' } } },
  ]);
  await expect(unoffered.invoke('calculate')).rejects.toMatchObject({
    name: 'MockModelError',
    message: 'The mock tool call was not offered.',
  });
  await expect(original.invoke('calculate')).rejects.toBeInstanceOf(MockModelError);
  expect((await bound.invoke('calculate')).tool_calls).toEqual(toolCalls);
});
