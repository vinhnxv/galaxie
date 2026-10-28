// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { HumanMessage } from '@langchain/core/messages';
import { expect, test } from 'vitest';
import { createMockLatch, MockChatModel, MockModelError } from '../src/mock.js';

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
