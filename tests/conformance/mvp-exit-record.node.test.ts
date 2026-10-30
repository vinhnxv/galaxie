// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

function acceptanceRows(markdown: string): string[][] {
  return markdown
    .split('\n')
    .filter((line) => /^\|\s*AT-\d+\s*\|/u.test(line))
    .map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
}

test('keeps MVP acceptance rows and evidence citations consistent with the repository', () => {
  const brief = readFileSync(
    new URL('../../docs/galaxie-project-brief.md', import.meta.url),
    'utf8',
  );
  const record = new URL('../../docs/mvp-exit-record.md', import.meta.url);
  const unsupported = new URL('../../docs/unsupported.md', import.meta.url);
  const markdown = readFileSync(record, 'utf8');
  const expected = acceptanceRows(brief);
  const rows = acceptanceRows(markdown);

  expect(expected.length, 'The brief must contain its acceptance table.').toBeGreaterThan(0);
  expect(
    rows.map(([id]) => id),
    'AT rows must be complete, unique and in brief order.',
  ).toEqual(expected.map(([id]) => id));
  expect(
    rows.map(([, name]) => name),
    'AT short names must match the brief.',
  ).toEqual(expected.map(([, name]) => name));
  const statuses = ['automated', 'automated + real-device demonstration', 'partial', 'gap'];
  for (const [id, , status] of rows) expect(statuses, id).toContain(status);

  const openItems = markdown.split(/^## Open items\b[^\n]*$/mu)[1] ?? '';
  const partialEvidence = /^- \*\*Partial acceptance evidence:\*\* (.*(?:\n[ \t]+.*)*)/mu.exec(
    openItems,
  )?.[1];
  expect(partialEvidence, 'Open items must name the partial acceptance evidence.').toBeDefined();
  expect(
    new Set(partialEvidence?.match(/AT-\d+/gu) ?? []),
    'Open items must name exactly the partial and gap rows.',
  ).toEqual(
    new Set(
      rows.filter(([, , status]) => status === 'partial' || status === 'gap').map(([id]) => id),
    ),
  );

  let quotedNames = 0;
  for (const [document, content] of [
    [record, markdown],
    [unsupported, readFileSync(unsupported, 'utf8')],
  ] as const) {
    const citations = content.matchAll(
      /\[[^\]\n]+\]\((\.\.\/(?:tests|packages|examples)\/[^)#\s]+)(?:#[^)]*)?\)/gu,
    );
    for (const citation of citations) {
      const path = citation[1] as string;
      const file = new URL(path, document);
      expect(existsSync(file), `${document.pathname}: missing cited file ${path}`).toBe(true);
      const names = /^:\s*((?:`[^`]+`(?:\s*[,;]\s*)?)+)/u.exec(
        content.slice(citation.index + citation[0].length),
      )?.[1];
      if (names === undefined) continue;
      const source = readFileSync(file, 'utf8');
      for (const [, name] of names.matchAll(/`([^`]+)`/gu)) {
        const title = name as string;
        const prefix = title.split(/%[sdifjoOc]|\$\{/u)[0] ?? title;
        expect(
          source.includes(title) || (prefix.length > 0 && source.includes(prefix)),
          `${path}: missing quoted test name: ${title}`,
        ).toBe(true);
        quotedNames++;
      }
    }
  }
  expect(quotedNames, 'The record must cite test names.').toBeGreaterThan(0);
});
