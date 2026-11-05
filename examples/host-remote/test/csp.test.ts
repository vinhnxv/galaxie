// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import { cspHeader } from '../src/csp.js';

test('host CSP denies form actions', () => {
  expect(cspHeader().split('; ')).toContain("form-action 'none'");
});
