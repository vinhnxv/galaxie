// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { Citation, RagOutput, SearchResult } from './schemas.js';

export function citeAnswer(reply: string, passages: SearchResult['passages']): RagOutput {
  const citations: Citation[] = [];
  const seen = new Set<number>();
  const answer = reply.replace(/\[([0-9]+)\]/g, (token: string, digits: string) => {
    const marker = Number(digits);
    const passage = passages[marker - 1];
    if (!Number.isSafeInteger(marker) || marker < 1 || !passage) return '';
    if (!seen.has(marker)) {
      seen.add(marker);
      citations.push({ marker, passageId: passage.id, title: passage.title, text: passage.text });
    }
    return token;
  });
  const sources = passages.map(({ id, title, text }) => ({ passageId: id, title, text }));
  return { answer, citations, sources };
}
