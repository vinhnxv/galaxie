// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'vitest';
import metadata from '../package.json' with { type: 'json' };
import { VERSION } from '../src/version.js';

test('instrumentation scope version matches the package', () => {
  expect(VERSION).toBe(metadata.version);
});
