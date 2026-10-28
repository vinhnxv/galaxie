// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

// The words of a sentence, as the pipeline lists them for the model and the page shows them.

const EDGE_PUNCTUATION = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

/** A whitespace-separated token without the punctuation around it; inner ' and - stay. */
export const cleanToken = (token: string): string => token.replace(EDGE_PUNCTUATION, '');

export function splitWords(sentence: string): string[] {
  return sentence
    .split(/\s+/)
    .map(cleanToken)
    .filter((word) => word !== '');
}
