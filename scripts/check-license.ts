// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

// Checks source headers and package license declarations required by ADR-0024.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';

const LICENSE = 'Apache-2.0';
const COPYRIGHT = 'SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh';
const IDENTIFIER = `SPDX-License-Identifier: ${LICENSE}`;
const LINE_HEADER = `// ${COPYRIGHT}\n// ${IDENTIFIER}\n`;
const HEADERS: Record<string, string> = {
  ...Object.fromEntries(
    ['ts', 'tsx', 'js', 'mjs', 'cjs', 'mts', 'cts', 'jsx', 'go'].map((extension) => [
      `.${extension}`,
      LINE_HEADER,
    ]),
  ),
  '.py': `# ${COPYRIGHT}\n# ${IDENTIFIER}\n`,
  '.css': `/* ${COPYRIGHT}\n   ${IDENTIFIER} */\n`,
  '.html': `<!-- ${COPYRIGHT}\n     ${IDENTIFIER} -->\n`,
};

// Tracked files plus new files that are not ignored, so work that is not committed yet is checked too.
const files = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  {
    encoding: 'utf8',
  },
)
  .split('\0')
  .filter((file) => file !== '' && existsSync(file));

const problems: string[] = [];
for (const file of files) {
  const extension = extname(file);
  const header = HEADERS[extension];
  if (header !== undefined) {
    let source = readFileSync(file, 'utf8').normalize('NFC');
    if (extension === '.py') source = source.replace(/^#![^\n]*\n/, '');
    if (extension === '.html') source = source.replace(/^<!doctype html>\r?\n/i, '');
    if (!source.startsWith(header.normalize('NFC'))) {
      problems.push(`${file}: does not start with the SPDX header`);
    }
  }
  if (basename(file) === 'package.json') {
    const { license } = JSON.parse(readFileSync(file, 'utf8')) as { license?: unknown };
    if (license !== LICENSE) {
      problems.push(`${file}: "license" is not "${LICENSE}"`);
    }
  }
  if (basename(file) === 'pyproject.toml') {
    const project = readFileSync(file, 'utf8')
      .split(/^\[project\][ \t]*(?:#.*)?\r?\n/m)[1]
      ?.split(/^\[/m)[0];
    const declaration = new RegExp(
      `^license[ \\t]*=[ \\t]*"${LICENSE.replaceAll('.', '\\.')}"[ \\t]*(?:#.*)?\\r?$`,
      'm',
    );
    if (!declaration.test(project ?? '')) {
      problems.push(`${file}: license is not "${LICENSE}"`);
    }
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exitCode = 1;
}
