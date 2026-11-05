// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, onTestFinished, test } from 'vitest';

const script = fileURLToPath(new URL('../../scripts/check-license.ts', import.meta.url));
const copyright = 'SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh';
const identifier = 'SPDX-License-Identifier: Apache-2.0';
const lineHeader = `// ${copyright}\n// ${identifier}\n`;
const pythonHeader = `# ${copyright}\n# ${identifier}\n`;
const htmlHeader = `<!-- ${copyright}\n     ${identifier} -->\n`;
const cssHeader = `/* ${copyright}\n   ${identifier} */\n`;

function run(files: Record<string, string>): { status: number | null; output: string } {
  const root = mkdtempSync(join(tmpdir(), 'galaxie-license-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet', root]);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
  return { status: result.status, output: result.stdout + result.stderr };
}

test('a TypeScript file with the old AGPL header fails', () => {
  const result = run({ 'main.ts': lineHeader.replace('Apache-2.0', 'AGPL-3.0-only') });
  expect(result.status).toBe(1);
  expect(result.output).toContain('main.ts: does not start with the SPDX header');
});

test.each(['ts', 'tsx', 'js', 'mjs', 'cjs', 'mts', 'cts', 'jsx', 'py', 'go', 'html', 'css'])(
  'a %s file missing its header fails',
  (extension) => {
    const result = run({ [`main.${extension}`]: '' });
    expect(result.status).toBe(1);
    expect(result.output).toContain(`main.${extension}: does not start with the SPDX header`);
  },
);

test.each([
  ['package.json', JSON.stringify({ license: 'AGPL-3.0-only' })],
  ['python/pyproject.toml', '[project]\nlicense = "AGPL-3.0-only"\n'],
])('%s with the old license fails', (path, content) => {
  const result = run({ [path]: content });
  expect(result.status).toBe(1);
  expect(result.output).toContain(`${path}:`);
  expect(result.output).toContain('is not "Apache-2.0"');
});

test('a license outside the project table does not satisfy pyproject.toml', () => {
  const result = run({
    'pyproject.toml': '[project]\nname = "example"\n[tool.example]\nlicense = "Apache-2.0"\n',
  });
  expect(result.status).toBe(1);
  expect(result.output).toContain('pyproject.toml: license is not "Apache-2.0"');
});

test('separate HTML or CSS comments do not satisfy the single-block header', () => {
  const result = run({
    'main.html': `<!-- ${copyright} -->\n<!-- ${identifier} -->\n`,
    'main.css': `/* ${copyright} */\n/* ${identifier} */\n`,
  });
  expect(result.status).toBe(1);
  expect(result.output).toContain('main.html: does not start with the SPDX header');
  expect(result.output).toContain('main.css: does not start with the SPDX header');
});

test('a correct untracked tree passes, including normalized text, shebangs and doctypes', () => {
  const files: Record<string, string> = {
    'main.py': pythonHeader,
    'executable.py': `#!/usr/bin/env python3\n${pythonHeader}`,
    'main.go': lineHeader,
    'main.html': `${htmlHeader}<!doctype html>\n<html></html>\n`,
    'doctype-first.html': `<!DOCTYPE html>\n${htmlHeader}<html></html>\n`,
    'main.css': cssHeader,
    'package.json': JSON.stringify({ license: 'Apache-2.0' }),
    'python/pyproject.toml': '[build-system]\nrequires = []\n[project]\nlicense = "Apache-2.0"\n',
    '.gitignore': 'ignored/\n',
    'ignored/vendor.js': 'third-party code without a project header\n',
  };
  for (const extension of ['ts', 'tsx', 'js', 'mjs', 'cjs', 'mts', 'cts', 'jsx']) {
    files[`src/main.${extension}`] = lineHeader.normalize('NFD');
  }
  expect(run(files)).toEqual({ status: 0, output: '' });
});
