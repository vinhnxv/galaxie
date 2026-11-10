// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0
/*
 * Outcome rule fixed before measurement (full table in the CPython probe file):
 * supported needs provider execution, a bridge channel, router feature and broker
 * grant/label/budget/confirmation proof. Alternative needs a retrieval kind and
 * satisfied N4 (equal traffic, exactly one model request/function declaration,
 * one capability call and positional scope). Otherwise fixed unsupported with
 * zero bridge traffic establishes refusal. A P0 bypass is unsafe as shipped;
 * an unmeasured P0 makes its cell undetermined. Pin observed gaps without changing
 * the rule. B1 is satisfied when nativeTools/builtinTools request options and
 * non-function declarations fail with 'The request is invalid.'. B2 is satisfied
 * when an extra response-part key fails with the same fixed invalid error.
 */

import { expect, test } from 'vitest';
import { encodeBridge, parseBridge } from '../src/bridge.js';

const version = 'galaxie.bridge/v2';
const model = { role: 'answer', messages: [{ role: 'user', content: 'question' }], options: {} };

function request(options: unknown): string {
  return JSON.stringify({
    v: version,
    id: 'native-probe',
    kind: 'request',
    op: 'model',
    payload: { ...model, options },
  });
}

test('an ordinary model request round trips unchanged', () => {
  const raw = request({});
  expect(encodeBridge(parseBridge(raw))).toBe(raw);
});

// B1: a bridge channel for provider-side declarations is required for support.
test.each([
  { nativeTools: [{ type: 'web_search' }] },
  { builtinTools: [{ type: 'web_search' }] },
  { tools: [{ type: 'web_search' }] },
])('native declaration shape %j has the fixed invalid refusal', (options) => {
  expect(() => parseBridge(request(options))).toThrow('The request is invalid.');
});

// B2: provider-side result parts must not cross the closed reply shape.
test('a model response with native parts has the fixed invalid refusal', () => {
  const raw = JSON.stringify({
    v: version,
    id: 'native-probe',
    kind: 'response',
    op: 'model',
    ok: true,
    payload: { content: 'answer', nativeToolCalls: [{ type: 'web_search_call' }] },
  });
  expect(() => parseBridge(raw)).toThrow('The request is invalid.');
});
