// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'vitest';
import { cspHeader } from '../src/csp.js';

test('host CSP denies form actions', () => {
  expect(cspHeader().split('; ')).toContain("form-action 'none'");
});
