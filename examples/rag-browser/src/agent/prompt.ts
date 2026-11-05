// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import prompt from './prompt.json' with { type: 'json' };
import type { SearchResult } from './schemas.js';

export const systemPrompt: string = prompt.system;
export function userPrompt(question: string, passages: SearchResult['passages']): string {
  const references = JSON.stringify(
    passages.map(({ id, title, text }, index) => ({ marker: index + 1, id, title, text })),
  );
  return `${prompt.questionPrefix}${question}${prompt.referenceStart}${references}${prompt.referenceEnd}${passages.length === 0 ? prompt.empty : prompt.usePassages}`;
}
