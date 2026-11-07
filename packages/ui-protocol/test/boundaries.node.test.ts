// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readdirSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { A2UI_SPEC_REVISION } from '../src/index.js';

test('copied upstream vectors retain their commit, source URL and Apache attribution', () => {
  const fixtures = readFileSync(new URL('./upstream-fixtures.ts', import.meta.url), 'utf8');
  expect(fixtures).toContain(`Upstream commit: ${A2UI_SPEC_REVISION}`);
  expect(fixtures).toContain(
    `https://github.com/a2ui-project/a2ui/blob/${A2UI_SPEC_REVISION}/specification/v1_0/docs/a2ui_protocol.md`,
  );
  expect(fixtures).toContain('Apache-2.0');
});

test('protocol source has no framework, galaxie, Node imports or DOM globals', () => {
  const directory = new URL('../src/', import.meta.url);
  for (const filename of readdirSync(directory).filter((name) => name.endsWith('.ts'))) {
    const source = readFileSync(new URL(filename, directory), 'utf8');
    expect(source).not.toMatch(
      /(?:from\s*|import\s*\()['"](?:react(?:-dom)?(?:\/|['"])|@galaxie\/|node:)/,
    );
    expect(source).not.toMatch(/\b(?:document|window|Worker)\b/);
  }
});
