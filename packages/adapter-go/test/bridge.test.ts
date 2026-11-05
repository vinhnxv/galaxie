// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import { parseRunResult } from '../src/bridge.js';
import { approvalRequest, pausedResult } from './support-go.js';

const id = 'a'.repeat(64);

test('a run result parses as output, failure or pause', () => {
  expect(parseRunResult('{"ok":true,"output":"hi"}')).toEqual({ ok: true, output: 'hi' });
  expect(parseRunResult('{"ok":true}')).toEqual({ ok: true, output: '' });
  expect(parseRunResult('{"ok":false,"code":"denied"}')).toEqual({ ok: false, code: 'denied' });
  expect(parseRunResult(pausedResult())).toEqual({
    ok: true,
    paused: { interactionId: id, request: approvalRequest },
  });
});

const pause = (value: unknown): string => JSON.stringify({ ok: true, paused: value });

test.each([
  [
    'an empty-string output beside a pause is allowed',
    JSON.stringify({
      ok: true,
      output: '',
      paused: { interactionId: id, request: approvalRequest },
    }),
    true,
  ],
  [
    'a pause with final text',
    JSON.stringify({
      ok: true,
      output: 'x',
      paused: { interactionId: id, request: approvalRequest },
    }),
    false,
  ],
  ['a non-object pause', pause('paused'), false],
  ['a null pause', pause(null), false],
  ['an array pause', pause([]), false],
  ['a pause without a request', pause({ interactionId: id }), false],
  ['a pause without an ID', pause({ request: approvalRequest }), false],
  [
    'an extra pause field',
    pause({ interactionId: id, request: approvalRequest, tools: [] }),
    false,
  ],
  ['a short ID', pause({ interactionId: 'abc', request: approvalRequest }), false],
  ['an upper-case ID', pause({ interactionId: 'A'.repeat(64), request: approvalRequest }), false],
  ['a long ID', pause({ interactionId: 'a'.repeat(65), request: approvalRequest }), false],
  ['a numeric ID', pause({ interactionId: 7, request: approvalRequest }), false],
  [
    'a request with a fifth field',
    pause({ interactionId: id, request: { ...approvalRequest, extra: 1 } }),
    false,
  ],
  [
    'a request without props',
    pause({ interactionId: id, request: { ...approvalRequest, props: undefined } }),
    false,
  ],
  [
    'a request with an empty surface',
    pause({ interactionId: id, request: { ...approvalRequest, surfaceId: '' } }),
    false,
  ],
  [
    'a request with an invalid component',
    pause({ interactionId: id, request: { ...approvalRequest, component: 'approval' } }),
    false,
  ],
  ['a request that is a string', pause({ interactionId: id, request: 'show it' }), false],
  ['an unknown top-level field', JSON.stringify({ ok: true, output: '', pause: {} }), false],
  [
    'a pause on a failure',
    JSON.stringify({
      ok: false,
      code: 'denied',
      paused: { interactionId: id, request: approvalRequest },
    }),
    false,
  ],
  ['an output that is not text', JSON.stringify({ ok: true, output: 3 }), false],
  ['text that is not JSON', 'paused', false],
])('%s', (_name, text, valid) => {
  if (valid) expect(() => parseRunResult(text)).not.toThrow();
  else expect(() => parseRunResult(text)).toThrowError(/invalid|unsupported/i);
});
