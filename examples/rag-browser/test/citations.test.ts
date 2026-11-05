// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import { citeAnswer } from '../src/agent/citations.js';
import cases from './fixtures/citation-cases.json' with { type: 'json' };

for (const item of cases)
  test(item.name, () => {
    expect(citeAnswer(item.reply, item.passages)).toEqual(item.expected);
  });
