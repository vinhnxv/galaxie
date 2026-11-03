// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  maxMessages,
  maxTextLength,
  parseFromWorker,
  parseToWorker,
  unavailableReasons,
} from '../src/transformers/protocol.js';
import { createSyntheticModel } from './support/transformers-model.js';

const request = {
  messages: [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ name: 'lookup', arguments: { q: 'x', nested: [1, 2, { a: null }] } }],
    },
    { role: 'tool', content: '{"ok":true}' },
  ],
  tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
  maxTokens: 64,
  temperature: 0,
  jsonSchema: { type: 'object' },
};

describe('page-to-worker messages', () => {
  it('accepts each valid message', async () => {
    const { record } = await createSyntheticModel();
    expect(parseToWorker({ type: 'load', record, allowDownload: false })?.type).toBe('load');
    expect(parseToWorker({ type: 'generate', id: 1, request })?.type).toBe('generate');
    expect(parseToWorker({ type: 'abort', id: 1 })).toEqual({ type: 'abort', id: 1 });
    expect(parseToWorker({ type: 'dispose' })).toEqual({ type: 'dispose' });
  });

  it('rejects unknown types, extra fields and wrong field types', async () => {
    const { record } = await createSyntheticModel();
    const bad: unknown[] = [
      null,
      'load',
      [],
      { type: 'other' },
      { type: 'dispose', extra: 1 },
      { type: 'abort', id: 0 },
      { type: 'abort', id: 1.5 },
      { type: 'abort', id: '1' },
      { type: 'load', record, allowDownload: 'no' },
      { type: 'load', record, allowDownload: false, extra: true },
      { type: 'load', record: { ...record, device: 'cpu' }, allowDownload: false },
      { type: 'generate', id: 1, request: { ...request, extra: 1 } },
      { type: 'generate', id: 1, request: { ...request, maxTokens: 0 } },
      { type: 'generate', id: 1, request: { ...request, maxTokens: -1 } },
      { type: 'generate', id: 1, request: { ...request, temperature: Number.NaN } },
      { type: 'generate', id: 1, request: { ...request, temperature: 5 } },
      { type: 'generate', id: 1, request: { ...request, messages: [] } },
      {
        type: 'generate',
        id: 1,
        request: { ...request, messages: [{ role: 'god', content: '' }] },
      },
      {
        type: 'generate',
        id: 1,
        request: { ...request, messages: [{ role: 'user', content: 'x', toolCalls: [] }] },
      },
    ];
    for (const value of bad) expect(parseToWorker(value), JSON.stringify(value)).toBeUndefined();
  });

  it('bounds message counts, text length and JSON size', () => {
    const many = Array.from({ length: maxMessages + 1 }, () => ({ role: 'user', content: 'x' }));
    expect(
      parseToWorker({ type: 'generate', id: 1, request: { ...request, messages: many } }),
    ).toBeUndefined();
    const long = [{ role: 'user', content: 'x'.repeat(maxTextLength + 1) }];
    expect(
      parseToWorker({ type: 'generate', id: 1, request: { ...request, messages: long } }),
    ).toBeUndefined();
    let deep: unknown = 1;
    for (let level = 0; level < 40; level += 1) deep = { next: deep };
    expect(
      parseToWorker({ type: 'generate', id: 1, request: { ...request, jsonSchema: deep } }),
    ).toBeUndefined();
    const wide = { items: Array.from({ length: 25_000 }, (_, index) => index) };
    expect(
      parseToWorker({ type: 'generate', id: 1, request: { ...request, jsonSchema: wide } }),
    ).toBeUndefined();
  });

  it('rejects non-plain objects in JSON positions', () => {
    class Custom {}
    expect(
      parseToWorker({
        type: 'generate',
        id: 1,
        request: { ...request, jsonSchema: new Custom() },
      }),
    ).toBeUndefined();
  });
});

describe('worker-to-page messages', () => {
  const device = { backend: 'wasm', thread: 'worker', vendor: 'v', architecture: 'a' };

  it('accepts each valid message', () => {
    expect(parseFromWorker({ type: 'ready', device })?.type).toBe('ready');
    expect(
      parseFromWorker({ type: 'progress', phase: 'verify', fraction: 0.5, elapsedSeconds: 2 }),
    ).toEqual({ type: 'progress', phase: 'verify', fraction: 0.5, elapsedSeconds: 2 });
    expect(parseFromWorker({ type: 'chunk', id: 2, text: 'hello' })?.type).toBe('chunk');
    expect(
      parseFromWorker({
        type: 'done',
        id: 2,
        usage: { promptTokens: 3, completionTokens: 4 },
        finishReason: 'length',
      })?.type,
    ).toBe('done');
    expect(parseFromWorker({ type: 'failed', code: 'unavailable', reason: 'integrity' })).toEqual({
      type: 'failed',
      code: 'unavailable',
      reason: 'integrity',
    });
  });

  it('rejects free-text failures, bad progress and bad usage', () => {
    const bad: unknown[] = [
      { type: 'failed', code: 'unavailable', message: 'secret prompt text' },
      { type: 'failed', code: 'unavailable', reason: 'a long engine message about the prompt' },
      { type: 'failed', code: 'invalid', reason: 'integrity' },
      { type: 'failed', code: 'boom' },
      { type: 'failed', id: 0, code: 'provider' },
      { type: 'progress', phase: 'verify', fraction: 1.5, elapsedSeconds: 1 },
      { type: 'progress', phase: 'verify', fraction: -0.1, elapsedSeconds: 1 },
      { type: 'progress', phase: 'warm', fraction: 0.5, elapsedSeconds: 1 },
      { type: 'progress', phase: 'verify', fraction: 0.5, elapsedSeconds: 1, detail: 'x' },
      { type: 'progress', phase: 'verify', fraction: 0.5, elapsedSeconds: -1 },
      { type: 'ready', device: { ...device, extra: 1 } },
      { type: 'ready', device: { ...device, backend: 'cpu' } },
      { type: 'ready', device: { ...device, thread: 'page' } },
      { type: 'ready', device, extra: 1 },
      { type: 'chunk', id: 1, text: 5 },
      {
        type: 'done',
        id: 1,
        usage: { promptTokens: -1, completionTokens: 0 },
        finishReason: 'stop',
      },
      { type: 'done', id: 1, usage: { promptTokens: 1, completionTokens: 0 }, finishReason: 'x' },
      {
        type: 'done',
        id: 1,
        usage: { promptTokens: 1, completionTokens: 0, extra: 1 },
        finishReason: 'stop',
      },
    ];
    for (const value of bad) expect(parseFromWorker(value), JSON.stringify(value)).toBeUndefined();
  });

  it('reports only reasons from the closed list', () => {
    for (const reason of unavailableReasons)
      expect(parseFromWorker({ type: 'failed', code: 'unavailable', reason })).toBeDefined();
  });
});
