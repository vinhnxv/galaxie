// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { globSync, readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import galaxie from '@galaxie/eslint-plugin';
import { ESLint } from 'eslint';
import { expect, test } from 'vitest';

const directory = fileURLToPath(new URL('../../examples/rag-browser/src/agent/', import.meta.url));
const eslint = new ESLint({
  overrideConfigFile: true,
  overrideConfig: [{ ...galaxie.configs.recommended, files: ['**/*.ts'] }],
});

test('lints every RAG agent source with the recommended agent rules', async () => {
  const files = globSync('**/*.ts', { cwd: directory }).sort();
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const filePath = join(directory, file);
    const code = stripTypeScriptTypes(readFileSync(filePath, 'utf8'), { mode: 'strip' });
    const results = await eslint.lintText(code, { filePath });
    expect(results).toHaveLength(1);
    for (const result of results) {
      expect(
        result.messages.every((message) => message.ruleId !== null),
        file,
      ).toBe(true);
      expect(result.messages, file).toEqual([]);
    }
  }
});

test('detects known-bad code through the same TypeScript file configuration', async () => {
  const code = stripTypeScriptTypes(
    `
      const value: string = 'private';
      fetch(value);
      localStorage.getItem(value);
      element.innerHTML = value;
      eval(value);
      import 'openai';
    `,
    { mode: 'strip' },
  );
  const results = await eslint.lintText(code, { filePath: join(directory, 'index.ts') });
  expect(results).toHaveLength(1);
  expect(results.flatMap((result) => result.messages.map((message) => message.ruleId))).toEqual([
    'galaxie/no-direct-network',
    'galaxie/no-direct-storage',
    'galaxie/no-dom',
    'galaxie/no-eval',
    'galaxie/no-direct-model',
  ]);
});
