// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

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
      const end = last === undefined ? 1000 : last.index + 1;
      passages.push(rest.slice(0, end).trim());
      rest = rest.slice(end).trim();
    }
    if (rest) passages.push(rest);
  }
  return passages;
}
