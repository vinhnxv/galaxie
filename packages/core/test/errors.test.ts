// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'vitest';
import { GalaxieError, isGalaxieError, toErrorInfo } from '../src/index.js';

test('a GalaxieError carries its code and cause', () => {
  const cause = new TypeError('Failed to fetch');
  const error = new GalaxieError('unreachable', 'The user endpoint did not answer.', { cause });

  expect(error).toBeInstanceOf(Error);
  expect(error.name).toBe('GalaxieError');
  expect(error.code).toBe('unreachable');
  expect(error.cause).toBe(cause);
});

test('stored errors use fixed messages and sanitized types', () => {
  const info = toErrorInfo('executor_error', new TypeError('secret'));
  expect(info).toEqual({
    code: 'executor_error',
    message: 'The executor or agent code failed.',
    type: 'TypeError',
  });
  expect(JSON.stringify(info)).not.toContain('secret');
  for (const name of ['Not a type', 'a'.repeat(65), 42]) {
    expect(toErrorInfo('executor_error', { name }).type).toBe('Error');
  }
});

test('unreachable has fixed likely causes without endpoint or error content', () => {
  expect(toErrorInfo('unreachable').message).toBe(
    'The endpoint did not answer. Local Network Access may be denied, CORS may not allow this app origin (for example OLLAMA_ORIGINS), or the server may be stopped.',
  );
});

test('GalaxieError recognition works across execution contexts', () => {
  expect(isGalaxieError(new GalaxieError('invalid', 'Invalid call.'))).toBe(true);
  expect(isGalaxieError({ name: 'GalaxieError', code: 'unsupported' })).toBe(true);
  expect(isGalaxieError({ name: 'GalaxieError', code: 'unknown' })).toBe(false);
  expect(isGalaxieError(null)).toBe(false);
});
