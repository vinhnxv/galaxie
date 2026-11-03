// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'vitest';
import { encodeBridge, failure, parseBridge, success } from '../src/bridge.js';

const version = 'galaxie.bridge/v2';
const tool = { type: 'function', function: { name: 'double', parameters: { type: 'object' } } };
const toolCall = {
  id: 'call_1',
  type: 'function',
  function: { name: 'double', arguments: '{"value":2}' },
};
const payloads = {
  boot: {
    runtimeUrl: 'https://example.test/python/',
    wheelsUrl: 'https://example.test/wheels/',
    localWheels: [],
    sources: [{ path: 'agent.py', text: 'def create_agent(): pass' }],
    module: 'agent',
    entry: 'create_agent',
  },
  run: { input: { question: 'hello' }, steps: 4, threadId: 'session' },
  pending: { threadId: 'session' },
  model: { role: 'answer', messages: [{ role: 'user', content: 'hello' }], options: {} },
  capability: { name: 'docs.search@1', input: { query: 'hello' }, effectScope: 'node:task' },
  abort: { runId: 'run-1' },
  checkpoint: { op: 'get', sessionId: 's', namespace: '' },
};

test('validates each request and checked response using JSON only', () => {
  for (const [op, payload] of Object.entries(payloads)) {
    const request = parseBridge(
      JSON.stringify({ v: version, kind: 'request', id: 'one', op, payload }),
    );
    expect(parseBridge(encodeBridge(request))).toEqual(request);
    expect(parseBridge(encodeBridge(failure(request, 'denied')))).toMatchObject({
      ok: false,
      error: { code: 'denied' },
    });
  }
  const request = parseBridge(
    JSON.stringify({ v: version, kind: 'request', id: 'one', op: 'run', payload: payloads.run }),
  );
  expect(
    parseBridge(encodeBridge(success(request, { output: { answer: 'Paris' } }, 'result'))),
  ).toMatchObject({ op: 'result', ok: true, payload: { output: { answer: 'Paris' } } });
});

test('rejects unknown versions, operations, payloads and oversized UTF-8 messages with fixed errors', () => {
  for (const value of [
    'not json',
    JSON.stringify({ kind: 'request', id: 'one', op: 'run', payload: payloads.run }),
    JSON.stringify({
      v: 'galaxie.bridge/v1',
      kind: 'request',
      id: 'one',
      op: 'run',
      payload: payloads.run,
    }),
    JSON.stringify({ v: version, kind: 'request', id: 'one', op: 'eval', payload: {} }),
    JSON.stringify({
      v: version,
      kind: 'request',
      id: 'one',
      op: 'run',
      payload: { input: null, steps: 0 },
    }),
    JSON.stringify({
      v: version,
      kind: 'request',
      id: 'one',
      op: 'boot',
      payload: { ...payloads.boot, sources: [{ path: '../escape.py', text: '' }] },
    }),
    JSON.stringify({
      v: version,
      kind: 'response',
      id: 'one',
      op: 'model',
      ok: true,
      payload: { content: 'reply', credential: 'secret' },
    }),
    JSON.stringify({
      v: version,
      kind: 'response',
      id: 'one',
      op: 'model',
      ok: false,
      error: { code: 'unknown', message: 'secret' },
    }),
  ]) {
    expect(() => parseBridge(value)).toThrow('The request is invalid.');
  }
});

test('oversized bridge messages fail unsupported without retaining their content', () => {
  expect(() => parseBridge('é'.repeat(524289))).toThrow('This operation is unsupported.');
});

test('checkpoint sub-operations and byte envelopes are closed and bounded after base64', () => {
  const binary = { type: 'msgpack', bytes: 'AP+A' };
  const location = { sessionId: 's', namespace: '' };
  for (const payload of [
    { op: 'get', ...location },
    { op: 'list', ...location, before: 'id', limit: 1 },
    {
      op: 'put',
      ...location,
      id: 'id',
      parentId: null,
      checkpoint: binary,
      metadata: binary,
      timestamp: '2026-10-30T00:00:00Z',
    },
    {
      op: 'put-writes',
      ...location,
      id: 'id',
      taskId: 'task',
      taskPath: 'parent',
      writes: [{ index: -3, channel: '__interrupt__', value: binary, interruptIds: ['i'] }],
    },
    { op: 'delete', sessionId: 's' },
  ]) {
    const raw = JSON.stringify({
      v: version,
      kind: 'request',
      id: 'one',
      op: 'checkpoint',
      payload,
    });
    expect(encodeBridge(parseBridge(raw))).toBe(raw);
  }
  for (const payload of [
    { op: 'unknown', ...location },
    { op: 'get', ...location, credential: 'private' },
    {
      op: 'put',
      ...location,
      id: 'id',
      parentId: null,
      checkpoint: { ...binary, bytes: 'invalid base64' },
      metadata: binary,
      timestamp: 'now',
    },
  ])
    expect(() =>
      parseBridge(
        JSON.stringify({ v: version, kind: 'request', id: 'one', op: 'checkpoint', payload }),
      ),
    ).toThrow('The request is invalid.');
  const tuple = {
    ...location,
    id: 'id',
    parentId: null,
    checkpoint: { type: 'bytes', bytes: 'A'.repeat(600000) },
    metadata: binary,
    writes: [],
    parentWrites: [
      {
        taskId: 'parent',
        channel: 'value',
        value: { type: 'bytes', bytes: 'A'.repeat(600000) },
        index: 0,
        taskPath: '',
      },
    ],
  };
  expect(() =>
    encodeBridge({
      v: version,
      kind: 'response',
      id: 'one',
      op: 'checkpoint',
      ok: true,
      payload: tuple,
    }),
  ).toThrow('This operation is unsupported.');
});

test('v2 resume, pending and notifications have closed payloads', () => {
  for (const message of [
    {
      kind: 'request',
      op: 'run',
      payload: {
        threadId: 's',
        steps: 4,
        resume: { interactionId: 'i', action: 'submit', payload: false },
      },
    },
    {
      kind: 'response',
      op: 'pending',
      ok: true,
      payload: { interrupts: [{ id: 'i', value: {} }] },
    },
    { kind: 'response', op: 'result', ok: true, payload: { interrupted: true } },
    { kind: 'notify', op: 'stream', payload: [[], 'updates', { node: {} }] },
    { kind: 'notify', op: 'model-chunk', payload: { content: 'checked delta' } },
  ]) {
    const raw = JSON.stringify({ v: version, id: 'one', ...message });
    expect(encodeBridge(parseBridge(raw))).toBe(raw);
  }
  for (const message of [
    {
      kind: 'request',
      op: 'run',
      payload: { ...payloads.run, resume: { interactionId: 'i', action: 'submit', payload: {} } },
    },
    { kind: 'request', op: 'pending', payload: { threadId: 's', extra: true } },
    { kind: 'notify', op: 'pending', payload: {} },
    { kind: 'notify', op: 'stream', payload: [[], 'unknown', null] },
    { kind: 'notify', op: 'model-chunk', payload: { content: 'delta', credential: 'secret' } },
  ])
    expect(() => parseBridge(JSON.stringify({ v: version, id: 'one', ...message }))).toThrow(
      'The request is invalid.',
    );
});

test('a model request may carry a JSON Schema object and nothing else in its place', () => {
  const base = { role: 'answer', messages: [{ role: 'user', content: 'x' }] };
  const frame = (options: unknown): string =>
    JSON.stringify({
      v: version,
      id: 'one',
      kind: 'request',
      op: 'model',
      payload: { ...base, options },
    });
  const raw = frame({ jsonSchema: { type: 'object', properties: { a: { type: 'string' } } } });
  expect(encodeBridge(parseBridge(raw))).toBe(raw);
  for (const jsonSchema of ['text', 1, null, ['a']])
    expect(() => parseBridge(frame({ jsonSchema }))).toThrow('The request is invalid.');
});

test('tool definitions, calls, results and argument deltas have closed JSON shapes', () => {
  const messages = [
    { role: 'user', content: 'double two' },
    { role: 'assistant', content: '', toolCalls: [toolCall] },
    { role: 'tool', content: '4', tool_call_id: 'call_1' },
  ];
  const offered = {
    role: 'answer',
    messages,
    options: {
      tools: [tool, { ...tool, function: { ...tool.function, name: 'other' } }],
      toolChoice: 'auto',
    },
  };
  for (const message of [
    { kind: 'request', op: 'model', payload: offered },
    { kind: 'response', op: 'model', ok: true, payload: { content: '', toolCalls: [toolCall] } },
    {
      kind: 'notify',
      op: 'model-chunk',
      payload: {
        content: '',
        toolCalls: [
          {
            index: 0,
            id: 'call_1',
            type: 'function',
            function: { name: 'double', arguments: '{' },
          },
        ],
      },
    },
  ]) {
    const raw = JSON.stringify({ v: version, id: 'one', ...message });
    expect(encodeBridge(parseBridge(raw))).toBe(raw);
  }
  for (const payload of [
    { ...offered, options: { tools: [{ ...tool, secret: true }] } },
    {
      ...offered,
      messages: [{ role: 'assistant', content: '', toolCalls: [{ ...toolCall, secret: true }] }],
    },
    { ...offered, messages: [{ role: 'tool', content: '4' }] },
    {
      ...offered,
      options: {
        tools: [tool],
        toolChoice: { type: 'function', function: { name: 'double', secret: true } },
      },
    },
  ])
    expect(() =>
      parseBridge(JSON.stringify({ v: version, id: 'one', kind: 'request', op: 'model', payload })),
    ).toThrow('The request is invalid.');
  expect(() =>
    parseBridge(
      JSON.stringify({
        v: version,
        id: 'one',
        kind: 'notify',
        op: 'model-chunk',
        payload: {
          content: '',
          toolCalls: [{ index: 0, function: { arguments: '{', secret: true } }],
        },
      }),
    ),
  ).toThrow('The request is invalid.');
});
