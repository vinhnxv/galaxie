// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'vitest';
import { ensureAdkRuntimeEnv } from '../src/runtime-shim.js';

const FLAG = 'ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS';

test('creates a frozen env-only process when none exists', () => {
  const scope = {};
  ensureAdkRuntimeEnv(scope);
  const created = Reflect.get(scope, 'process') as { env: Record<string, string> };
  expect(Object.keys(created)).toEqual(['env']);
  expect(created.env).toEqual({ [FLAG]: 'false' });
  expect(Object.isFrozen(created)).toBe(true);
  expect(Object.isFrozen(created.env)).toBe(true);
  expect(Object.keys(scope)).toEqual([]);
});

test('sets only the flag, and only when unset, on an existing process', () => {
  const unset = { process: { env: { OTHER: 'kept' } as Record<string, string> } };
  ensureAdkRuntimeEnv(unset);
  expect(unset.process.env).toEqual({ OTHER: 'kept', [FLAG]: 'false' });

  const chosen = { process: { env: { [FLAG]: 'true' } } };
  ensureAdkRuntimeEnv(chosen);
  expect(chosen.process.env[FLAG]).toBe('true');
});

test('fails closed when the flag cannot be set on a frozen env', () => {
  const scope = { process: { env: Object.freeze({}) } };
  expect(() => ensureAdkRuntimeEnv(scope)).toThrow('could not be turned off');
});

test('leaves a process without an env object alone', () => {
  const scope = { process: { version: 'v0' } };
  ensureAdkRuntimeEnv(scope);
  expect(scope.process).toEqual({ version: 'v0' });
});
