// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, onTestFinished, test } from 'vitest';

const script = fileURLToPath(new URL('../../scripts/check-docs.ts', import.meta.url));
const sections = ['Purpose', 'Entry points', 'Do', 'Never', 'Limits', 'Tests'];
const agents = sections.map((section) => `## ${section}\n\nText.\n`).join('\n');
const index = '# Fixture\n\n> Offline docs.\n\n## Docs\n\n- [Readme](README.md): start here.\n';

function fixture(extra: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'galaxie-docs-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const files = {
    'README.md': '# Hello, `World`!\n\n## Same\n\n## Same\n\n## Same-1\n\n## Same\n',
    'packages/demo/package.json': '{}',
    'packages/demo/README.md': '# Demo\n',
    'packages/demo/AGENTS.md': agents,
    'llms.txt': index,
    ...extra,
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  execFileSync('git', ['init', '--quiet', root]);
  execFileSync('git', ['add', '--', ...Object.keys(files)], { cwd: root });
  return root;
}

function run(root: string): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
  return { status: result.status, output: result.stdout + result.stderr };
}

test('checks local links, images, references, encoded paths and duplicate GitHub slugs', () => {
  const root = fixture({
    'guide.md': [
      '# Guide',
      '[Heading](README.md#hello-world)',
      '[Second](README.md#same-1)',
      '[Collision](README.md#same-1-1)',
      '[Third](README.md#same-2)',
      '[Local](#guide)',
      '![Image](assets/a%20b.svg)',
      '[Reference][readme]',
      '[readme]: README.md "Title"',
      '[Shortcut]',
      '[shortcut]: <assets/a b.svg>',
      '[Nested](assets/a(b).svg "Title")',
      '[Query](README.md?raw=1#same)',
      '[External](https://example.invalid/no-fetch)',
      '[Email](mailto:test@example.invalid)',
      '`[Ignored](missing.md)`',
      '``[Ignored ` code](missing.md)``',
      '```md',
      '[Ignored](missing.md)',
      '```',
      '~~~md',
      '[Ignored](missing.md)',
      '~~~',
    ].join('\n'),
    'assets/a b.svg': '<svg/>',
    'assets/a(b).svg': '<svg/>',
    'docs/plans/plan.md': '[Excluded](missing.md)',
    'internal/private.md': '[Excluded](missing.md)',
    'node_modules/demo/README.md': '[Excluded](missing.md)',
  });
  // Untracked files are outside this check's contract.
  writeFileSync(join(root, 'untracked.md'), '[Ignored](missing.md)');
  expect(run(root)).toEqual({ status: 0, output: '' });
});

test.each([
  ['[Missing](absent.md)', 'missing target: absent.md'],
  ['![Missing](absent.png)', 'missing target: absent.png'],
  ['[Missing](README.md#absent)', 'missing heading: README.md#absent'],
  ['[Missing](#absent)', 'missing heading: #absent'],
  ['[Missing][ref]\n\n[ref]: absent.md', 'missing target: absent.md'],
])('reports a file and line for %s', (link, message) => {
  const result = run(fixture({ 'guide.md': `# Guide\n\n${link}\n` }));
  expect(result.status).toBe(1);
  expect(result.output).toContain(`guide.md:3: ${message}`);
});

test.each(['AGENTS.md', 'README.md'])('requires each package %s', (name) => {
  const root = fixture();
  rmSync(join(root, 'packages/demo', name));
  const result = run(root);
  expect(result.status).toBe(1);
  expect(result.output).toContain(`packages/demo/${name}:1: missing required file`);
});

test.each(sections)('requires the package %s section', (section) => {
  const result = run(fixture({ 'packages/demo/AGENTS.md': agents.replace(`## ${section}\n`, '') }));
  expect(result.status).toBe(1);
  expect(result.output).toContain(`packages/demo/AGENTS.md:1: missing section: ${section}`);
});

test.each([
  [index.replace('# Fixture\n', ''), 'missing H1'],
  [index.replace('> Offline docs.\n', ''), 'missing blockquote summary'],
  [index.replace('## Docs\n', ''), 'missing H2 section'],
  [index.replace('README.md', 'absent.md'), 'missing target: absent.md'],
])('validates the llms.txt structure and targets', (content, message) => {
  const result = run(fixture({ 'llms.txt': content }));
  expect(result.status).toBe(1);
  expect(result.output).toContain(message);
});

test('requires llms.txt', () => {
  const root = fixture();
  rmSync(join(root, 'llms.txt'));
  expect(run(root)).toEqual({
    status: 1,
    output: 'llms.txt:1: missing required file\n',
  });
});

test('passes on the tracked repository documentation', () => {
  expect(run(fileURLToPath(new URL('../..', import.meta.url)))).toEqual({
    status: 0,
    output: '',
  });
});
