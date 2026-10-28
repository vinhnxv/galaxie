// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

// Checks the license markers that ADR-0015 requires: the SPDX header at the top of every
// JavaScript and TypeScript file, and `"license": "AGPL-3.0-only"` in every package.json.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

const LICENSE = 'AGPL-3.0-only';
const HEADER =
  `// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh\n// SPDX-License-Identifier: ${LICENSE}\n`.normalize(
    'NFC',
  );
const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

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
  if (SOURCE_FILE.test(file) && !readFileSync(file, 'utf8').normalize('NFC').startsWith(HEADER)) {
    problems.push(`${file}: does not start with the SPDX header`);
  }
  if (basename(file) === 'package.json') {
    const { license } = JSON.parse(readFileSync(file, 'utf8')) as { license?: unknown };
    if (license !== LICENSE) {
      problems.push(`${file}: "license" is not "${LICENSE}"`);
    }
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exitCode = 1;
}
