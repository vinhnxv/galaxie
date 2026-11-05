// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import { userPrompt } from '../src/agent/prompt.js';
import cases from './fixtures/prompt-cases.json' with { type: 'json' };

for (const item of cases)
  test(`formats the shared prompt: ${item.name}`, () => {
    expect(userPrompt(item.question, item.passages)).toBe(item.expected);
  });
