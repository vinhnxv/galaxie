// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { checkCommits } from '../../scripts/check-dco.ts';

const scriptPath = fileURLToPath(new URL('../../scripts/check-dco.ts', import.meta.url));

function withRepository(run: (cwd: string, git: (...args: string[]) => string) => void): void {
  const cwd = mkdtempSync(join(tmpdir(), 'galaxie-dco-'));
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(cwd, 'unused-git-config'),
    GIT_AUTHOR_NAME: 'Test Author',
    GIT_AUTHOR_EMAIL: 'author@example.test',
    GIT_COMMITTER_NAME: 'Test Author',
    GIT_COMMITTER_EMAIL: 'author@example.test',
  };
  const git = (...args: string[]): string => {
    const result = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], {
      cwd,
      env,
      encoding: 'utf8',
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    return result.stdout.trim();
  };
  try {
    git('init', '-b', 'main');
    git('commit', '--allow-empty', '-s', '-m', 'Signed base');
    run(cwd, git);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function runCheck(cwd: string, range: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [scriptPath, range], { cwd, encoding: 'utf8' });
}

test('a range of signed commits passes', () => {
  withRepository((cwd, git) => {
    const base = git('rev-parse', 'HEAD');
    git('commit', '--allow-empty', '-s', '-m', 'First signed change');
    git('commit', '--allow-empty', '-s', '-m', 'Second signed change');
    const result = runCheck(cwd, `${base}..HEAD`);
    expect(result.status, String(result.stderr)).toBe(0);
    expect(String(result.stdout)).toContain('Checked 2 commits; skipped 0 merge commits.');
    expect(checkCommits([])).toEqual({ checked: 0, skipped: 0, failures: [] });
  });
});

test('an unsigned commit fails and only the offending commit is named', () => {
  withRepository((cwd, git) => {
    const base = git('rev-parse', 'HEAD');
    git('commit', '--allow-empty', '-s', '-m', 'Signed before');
    const before = git('rev-parse', '--short=7', 'HEAD');
    git('commit', '--allow-empty', '-m', 'Unsigned change');
    const unsigned = git('rev-parse', '--short=7', 'HEAD');
    git('commit', '--allow-empty', '-s', '-m', 'Signed after');
    const after = git('rev-parse', '--short=7', 'HEAD');
    const result = runCheck(cwd, `${base}..HEAD`);
    const output = String(result.stderr);
    expect(result.status, output).toBe(1);
    expect(output).toContain(`${unsigned} Unsigned change: missing Signed-off-by`);
    for (const signed of [before, after, 'Signed before', 'Signed after']) {
      expect(output).not.toContain(signed);
    }
    expect(output).toContain('CONTRIBUTING.md');
  });
});

test('a sign-off by a committer with a different author email fails', () => {
  withRepository((cwd, git) => {
    const base = git('rev-parse', 'HEAD');
    const author = 'Test Author <different@example.test>';
    git('commit', '--allow-empty', `--author=${author}`, '-s', '-m', 'Mismatched sign-off');
    const hash = git('rev-parse', '--short=7', 'HEAD');
    const result = runCheck(cwd, `${base}..HEAD`);
    expect(result.status, String(result.stderr)).toBe(1);
    expect(String(result.stderr)).toContain(
      `${hash} Mismatched sign-off: no Signed-off-by matches author ${author}`,
    );
  });
});

test('an unsigned merge is skipped while signed commits around it pass', () => {
  withRepository((cwd, git) => {
    const base = git('rev-parse', 'HEAD');
    git('checkout', '-b', 'topic');
    git('commit', '--allow-empty', '-s', '-m', 'Signed topic change');
    git('checkout', 'main');
    git('commit', '--allow-empty', '-s', '-m', 'Signed main change');
    git('merge', '--no-ff', '--no-edit', 'topic');
    expect(git('log', '-1', '--format=%B')).not.toContain('Signed-off-by');
    git('commit', '--allow-empty', '-s', '-m', 'Signed after merge');
    const result = runCheck(cwd, `${base}..HEAD`);
    expect(result.status, String(result.stderr)).toBe(0);
    expect(String(result.stdout)).toContain('Checked 3 commits; skipped 1 merge commits.');
  });
});
