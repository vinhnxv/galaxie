// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'vitest';
import { GalaxieError } from '../src/index.js';

test('a GalaxieError carries its code and cause', () => {
  const cause = new TypeError('Failed to fetch');
  const error = new GalaxieError('unreachable', 'The user endpoint did not answer.', { cause });

  expect(error).toBeInstanceOf(Error);
  expect(error.name).toBe('GalaxieError');
  expect(error.code).toBe('unreachable');
  expect(error.cause).toBe(cause);
});
