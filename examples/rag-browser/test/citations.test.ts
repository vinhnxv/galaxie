// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'vitest';
import { citeAnswer } from '../src/agent/citations.js';
import cases from './fixtures/citation-cases.json' with { type: 'json' };

for (const item of cases)
  test(item.name, () => {
    expect(citeAnswer(item.reply, item.passages)).toEqual(item.expected);
  });
