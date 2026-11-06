// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';

interface Commit {
  readonly hash: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly parentCount: number;
  readonly subject: string;
  readonly message: string;
}

interface CheckResult {
  readonly checked: number;
  readonly skipped: number;
  readonly failures: readonly string[];
}

export function checkCommits(commits: readonly Commit[]): CheckResult {
  let checked = 0;
  let skipped = 0;
  const failures: string[] = [];
  for (const commit of commits) {
    if (commit.parentCount > 1) {
      skipped++;
      continue;
    }
    checked++;
    const signoffs = [
      ...commit.message.matchAll(/^Signed-off-by:[ \t]*(.*?) <([^<>\r\n]+)>[ \t]*$/gim),
    ];
    const matches = signoffs.some(
      (signoff) =>
        signoff[1]?.trim() === commit.authorName.trim() &&
        signoff[2]?.trim().toLowerCase() === commit.authorEmail.trim().toLowerCase(),
    );
    if (!matches) {
      const reason =
        signoffs.length === 0
          ? 'missing Signed-off-by'
          : `no Signed-off-by matches author ${commit.authorName} <${commit.authorEmail}>`;
      failures.push(`${commit.hash.slice(0, 7)} ${commit.subject}: ${reason}`);
    }
  }
  return { checked, skipped, failures };
}

// hash, author name, author email, parents, subject, body: the order `main` reads them in.
const LOG_FIELDS = ['%H', '%an', '%ae', '%P', '%s', '%B'] as const;

function main(): void {
  const range = process.argv[2];
  if (range === undefined) {
    console.error('Usage: node scripts/check-dco.ts <revision-range>');
    process.exitCode = 2;
    return;
  }
  const fields = execFileSync(
    'git',
    ['log', '-z', `--format=${LOG_FIELDS.join('%x00')}`, range, '--'],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  ).split('\0');
  const commits: Commit[] = [];
  for (let index = 0; index < fields.length - 1; index += LOG_FIELDS.length) {
    commits.push({
      hash: fields[index] ?? '',
      authorName: fields[index + 1] ?? '',
      authorEmail: fields[index + 2] ?? '',
      parentCount: (fields[index + 3] ?? '').split(' ').filter(Boolean).length,
      subject: fields[index + 4] ?? '',
      message: fields[index + 5] ?? '',
    });
  }
  const result = checkCommits(commits);
  if (result.failures.length > 0) {
    console.error(result.failures.join('\n'));
    console.error('See CONTRIBUTING.md for how to add or repair matching DCO sign-offs.');
    process.exitCode = 1;
    return;
  }
  console.log(`Checked ${result.checked} commits; skipped ${result.skipped} merge commits.`);
}

if (import.meta.main) main();
