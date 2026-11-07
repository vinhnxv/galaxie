// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import {
  encodeValidatedJson,
  hasOnlyKeys,
  isJsonValue,
  isRecord,
  MAX_BRIDGE_BYTES,
  parseJsonText,
  validBridgeTool,
  validBridgeToolCall,
  validCapabilityRequest,
  validChatMessage,
  validModelOption,
  withinBridgeLimit,
} from '../src/index.js';

const tool = { type: 'function', function: { name: 'double', parameters: { type: 'object' } } };
const call = {
  id: 'call_1',
  type: 'function',
  function: { name: 'double', arguments: '{"value":2}' },
};

test('JSON framing keeps exact UTF-8 limits and rejects malformed JSON', () => {
  expect(() => parseJsonText('not json')).toThrow();
  expect(parseJsonText('{"content":"hello"}')).toEqual({ content: 'hello' });
  expect(withinBridgeLimit('a'.repeat(MAX_BRIDGE_BYTES))).toBe(true);
  expect(withinBridgeLimit('a'.repeat(MAX_BRIDGE_BYTES + 1))).toBe(false);
  expect(withinBridgeLimit('é'.repeat(MAX_BRIDGE_BYTES / 2))).toBe(true);
  expect(withinBridgeLimit('é'.repeat(MAX_BRIDGE_BYTES / 2 + 1))).toBe(false);
  expect(withinBridgeLimit('😀'.repeat(MAX_BRIDGE_BYTES / 4))).toBe(true);
  expect(withinBridgeLimit('😀'.repeat(MAX_BRIDGE_BYTES / 4 + 1))).toBe(false);
});

test('validated framing refuses unknown versions, operations and envelope fields', () => {
  // Envelopes remain adapter-owned; the shared framing calls their validator before encoding.
  const validate = (value: unknown): void => {
    if (
      !isJsonValue(value) ||
      !isRecord(value) ||
      !hasOnlyKeys(value, ['v', 'kind', 'id', 'op', 'payload']) ||
      value['v'] !== 'galaxie.bridge/v2' ||
      value['kind'] !== 'request' ||
      value['id'] !== 'one' ||
      value['op'] !== 'capability' ||
      !isRecord(value['payload']) ||
      !hasOnlyKeys(value['payload'], ['name', 'input']) ||
      !validCapabilityRequest(value['payload'])
    )
      throw new TypeError('The request is invalid.');
  };
  const frame = {
    v: 'galaxie.bridge/v2',
    kind: 'request',
    id: 'one',
    op: 'capability',
    payload: { name: 'docs.search@1', input: {} },
  };
  expect(parseJsonText(encodeValidatedJson(frame, validate))).toEqual(frame);
  for (const malformed of [
    { ...frame, v: 'galaxie.bridge/v1' },
    { ...frame, op: 'eval' },
    { ...frame, credential: 'private' },
    { ...frame, payload: { ...frame.payload, credential: 'private' } },
    { ...frame, payload: { ...frame.payload, input: Number.NaN } },
  ])
    expect(() => encodeValidatedJson(malformed, validate)).toThrow('The request is invalid.');
});

test('closed tool, call, message and option shapes reject malformed and credential fields', () => {
  expect(validBridgeTool(tool)).toBe(true);
  expect(validBridgeToolCall(call)).toBe(true);
  expect(
    validChatMessage({ role: 'assistant', content: '', toolCalls: [call] }, validBridgeToolCall),
  ).toBe(true);
  for (const value of [
    null,
    [],
    { ...call, credential: 'private' },
    { ...call, id: '' },
    { ...call, function: { ...call.function, arguments: {} } },
    { ...call, function: { ...call.function, credential: 'private' } },
  ])
    expect(validBridgeToolCall(value)).toBe(false);
  expect(validBridgeTool({ ...tool, secret: true })).toBe(false);
  expect(validBridgeTool({ ...tool, function: { ...tool.function, credential: 'private' } })).toBe(
    false,
  );
  expect(validChatMessage({ role: 'tool', content: '4' }, validBridgeToolCall)).toBe(false);
  expect(
    validChatMessage(
      { role: 'assistant', content: '', toolCalls: [{ ...call, secret: true }] },
      validBridgeToolCall,
    ),
  ).toBe(false);
  expect(validChatMessage({ role: 'unknown', content: '' }, validBridgeToolCall)).toBe(false);
  expect(validModelOption('tools', [tool], validBridgeTool)).toBe(true);
  expect(validModelOption('tools', [{ ...tool, secret: true }], validBridgeTool)).toBe(false);
  expect(validModelOption('stop', [1])).toBe(false);
  expect(validModelOption('stream', 'yes')).toBe(false);
  for (const value of ['text', 1, null, ['a']])
    expect(validModelOption('jsonSchema', value)).toBe(false);
});

test('recursive JSON retains prototype, depth and array-property differences', () => {
  const checks = { plainObjects: false, maxDepth: 64, arrayProperties: false };
  const cycle: Record<string, unknown> = {};
  cycle['self'] = cycle;
  for (const value of [cycle, Number.POSITIVE_INFINITY, undefined, () => {}]) {
    expect(isJsonValue(value)).toBe(false);
    expect(isJsonValue(value, checks)).toBe(false);
  }
  const child = { value: true };
  expect(isJsonValue([child, child])).toBe(true);
  expect(isJsonValue(new Date())).toBe(false);
  expect(isJsonValue(new Date(), checks)).toBe(true);
  let nested: unknown = null;
  for (let depth = 0; depth < 64; depth++) nested = [nested];
  expect(isJsonValue(nested, checks)).toBe(true);
  expect(isJsonValue([nested], checks)).toBe(false);
  expect(isJsonValue([nested])).toBe(true);
  const array = Object.assign([], { extra: undefined });
  expect(isJsonValue(array)).toBe(false);
  expect(isJsonValue(array, checks)).toBe(true);
  const hidden = Object.defineProperty({}, 'required', { value: true });
  expect(hasOnlyKeys(hidden, ['required'])).toBe(true);
  expect(hasOnlyKeys(hidden, ['required'], [], true)).toBe(false);
});

test('Go identifier and tool-schema protections remain caller-selected', () => {
  const name = (value: unknown): boolean =>
    typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value);
  const id = (value: unknown): boolean => typeof value === 'string' && /^.{1,128}$/s.test(value);
  const json = (value: unknown): boolean =>
    isJsonValue(value, { plainObjects: false, maxDepth: 64, arrayProperties: false });
  const checks = {
    name,
    json,
    strict: false,
    descriptionFirst: true,
    enumerableRequired: true,
  };
  expect(validBridgeTool(tool, checks)).toBe(true);
  expect(validBridgeTool({ ...tool, function: { ...tool.function, strict: true } }, checks)).toBe(
    false,
  );
  expect(
    validBridgeToolCall({ ...call, function: { ...call.function, name: 'has-dash' } }, name, id),
  ).toBe(false);
  expect(validBridgeToolCall({ ...call, function: { ...call.function, name: 'has-dash' } })).toBe(
    true,
  );
  expect(validCapabilityRequest({ name: 'docs.search@1', input: [] }, json, true)).toBe(false);
  expect(validCapabilityRequest({ name: 'docs.search@1', input: [] }, json)).toBe(true);
  expect(validCapabilityRequest({ name: '', input: {} }, json)).toBe(false);
});

test('enumerable required keys are enforced only where the caller selects them', () => {
  const hidden = (shape: Record<string, unknown>, key: string): Record<string, unknown> =>
    Object.defineProperty({ ...shape }, key, { value: shape[key], enumerable: false });
  const message = { role: 'user', content: 'hello' };
  const name = (value: unknown): boolean => typeof value === 'string' && value.length > 0;
  const json = (value: unknown): boolean => isJsonValue(value);
  const checks = { name, json, strict: true, descriptionFirst: false };
  const hiddenCall = hidden(call, 'id');
  const hiddenMessage = hidden(message, 'content');
  const hiddenTool = hidden(tool, 'type');
  expect(validBridgeToolCall(hiddenCall)).toBe(true);
  expect(validBridgeToolCall(hiddenCall, name, undefined, true)).toBe(false);
  expect(validChatMessage(hiddenMessage, validBridgeToolCall)).toBe(true);
  expect(validChatMessage(hiddenMessage, validBridgeToolCall, undefined, true)).toBe(false);
  expect(validBridgeTool(hiddenTool, { ...checks, enumerableRequired: false })).toBe(true);
  expect(validBridgeTool(hiddenTool, { ...checks, enumerableRequired: true })).toBe(false);
});

test('closed-key checks retain required-field and enumeration order', () => {
  const reads: string[] = [];
  const value = new Proxy(
    {},
    {
      getOwnPropertyDescriptor: () => {
        reads.push('required');
        return undefined;
      },
      ownKeys: () => {
        reads.push('enumerate');
        return [];
      },
    },
  );
  expect(hasOnlyKeys(value, ['missing'])).toBe(false);
  expect(reads).toEqual(['required']);
  reads.length = 0;
  expect(hasOnlyKeys(value, ['missing'], [], true)).toBe(false);
  expect(reads).toEqual(['enumerate']);
});
