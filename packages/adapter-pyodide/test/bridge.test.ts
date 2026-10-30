// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'vitest';
import { encodeBridge, failure, parseBridge, success } from '../src/bridge.js';

const version = 'galaxie.bridge/v2';
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
