// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

export function chunkText(text: string): string[] {
  const passages: string[] = [];
  for (const paragraph of text
    .split(/\n\s*\n/)
    .map((value) => value.trim())
    .filter(Boolean)) {
    let rest = paragraph;
    while (rest.length > 1000) {
      const prefix = rest.slice(0, 1000);
      const endings = [...prefix.matchAll(/[.!?](?:\s|$)/g)];
      const last = endings.at(-1);
      // Without a sentence end the cut is hard; it must not fall between the halves of a pair.
      const hardCut = isHighSurrogate(prefix.charCodeAt(999)) ? 999 : 1000;
      const end = last === undefined ? hardCut : last.index + 1;
      passages.push(rest.slice(0, end).trim());
      rest = rest.slice(end).trim();
    }
    if (rest) passages.push(rest);
  }
  return passages;
}
