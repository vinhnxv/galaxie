// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, onTestFinished, test } from 'vitest';
import metadata from '../../core/package.json' with { type: 'json' };
import { compose, LayerCollisionError } from '../src/compose.js';
import { GuidanceError, loadGuidanceSource, renderGuidance } from '../src/guidance.js';
import { loadLayers } from '../src/layers.js';
import { planWrite, writeProject } from '../src/write.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const source = loadGuidanceSource(join(repo, 'skills/galaxie'));
const selection = { kind: 'browser-only', framework: 'langgraph-js' };
const combinations = ['browser-only', 'gateway'].flatMap((kind) =>
  ['langgraph-js', 'adk-js', 'adk-go', 'langgraph-python'].map((framework) => ({
    kind,
    framework,
  })),
);
const text = (bytes: Uint8Array | undefined): string => Buffer.from(bytes ?? []).toString();
async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'galaxie-guidance-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  return root;
}

test.each(combinations)(
  '$kind-$framework renders the pinned block and identical source subsets',
  async (choice) => {
    const input = await source;
    const rendered = renderGuidance(input, choice);
    expect(rendered).toEqual(renderGuidance(input, choice));
    expect([...rendered.keys()]).toEqual([...rendered.keys()].sort());
    const agents = text(rendered.get('AGENTS.md'));
    await expect(agents).toMatchFileSnapshot(
      `golden/${choice.kind}-${choice.framework}.golden.txt`,
    );
    expect(Buffer.byteLength(agents)).toBeLessThan(8192);
    expect(
      agents.split(`<!-- galaxie:begin guidance=1 skill=${metadata.version} -->`),
    ).toHaveLength(2);
    expect(agents.match(/<!-- galaxie:end -->/g)).toHaveLength(1);
    expect(agents.startsWith(`<!-- galaxie:begin guidance=1 skill=${metadata.version} -->\n`)).toBe(
      true,
    );
    expect(agents.endsWith('<!-- galaxie:end -->\n')).toBe(true);
    expect(agents).toContain('Significant writes require host-rendered, single-use confirmations');
    expect(agents).toContain('npm run check');
    expect(text(rendered.get('CLAUDE.md'))).toBe('@AGENTS.md\n');
    const paths = [
      'SKILL.md',
      'references/host-integration.md',
      'references/nextjs.md',
      `references/kind-${choice.kind}.md`,
      `references/framework-${choice.framework}.md`,
    ].sort();
    for (const directory of ['.agents', '.claude']) {
      const prefix = `${directory}/skills/galaxie/`;
      expect(
        [...rendered.keys()]
          .filter((path) => path.startsWith(prefix))
          .map((path) => path.slice(prefix.length)),
      ).toEqual(paths);
      for (const path of paths)
        expect(Buffer.from(rendered.get(prefix + path)!)).toEqual(Buffer.from(input.get(path)!));
    }
    for (const bytes of rendered.values()) {
      const prose = text(bytes)
        .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '')
        .replace(/`[^`]*`/g, '');
      expect(prose).not.toMatch(/\b(secure|secured|compliant|certified)\b/i);
      expect(text(bytes)).not.toContain('\r\n');
    }
  },
);

test.each(['SKILL.md', 'references/kind-browser-only.md', 'references/framework-langgraph-js.md'])(
  'missing %s is a clear guidance error',
  async (path) => {
    const input = new Map(await source);
    input.delete(path);
    expect(() => renderGuidance(input, selection)).toThrow(GuidanceError);
    expect(() => renderGuidance(input, selection)).toThrow(path);
  },
);

test.each(['SKILL.md', 'references/kind-browser-only.md', 'references/framework-langgraph-js.md'])(
  '%s requires one bounded summary',
  async (path) => {
    const original = text((await source).get(path));
    for (const content of [
      original.replace('<!-- galaxie:summary:start -->', ''),
      original.replace('<!-- galaxie:summary:end -->', ''),
      `${original}\n<!-- galaxie:summary:start -->\nduplicate\n<!-- galaxie:summary:end -->\n`,
      original.replace(
        /(<!-- galaxie:summary:start -->)[\s\S]*?(<!-- galaxie:summary:end -->)/,
        '$1\n$2',
      ),
      original.replace(
        /(<!-- galaxie:summary:start -->)[\s\S]*?(<!-- galaxie:summary:end -->)/,
        `$1\n${'é'.repeat(path === 'SKILL.md' ? 901 : 301)}\n$2`,
      ),
    ]) {
      const input = new Map(await source);
      input.set(path, Buffer.from(content));
      expect(() => renderGuidance(input, selection)).toThrow(GuidanceError);
      expect(() => renderGuidance(input, selection)).toThrow('summary');
    }
  },
);

test('a skill version is required for the managed block', async () => {
  const input = new Map(await source);
  input.set(
    'SKILL.md',
    Buffer.from(text(input.get('SKILL.md')).replace(`version: ${metadata.version}\n`, '')),
  );
  expect(() => renderGuidance(input, selection)).toThrow('version');
});

test('guidance only adds paths through composition and retains collision and path checks', async () => {
  const layers = await loadLayers(join(repo, 'templates'));
  const options = { ...selection, name: 'my-app', mode: 'project', packageManager: 'npm' } as const;
  const baseline = compose(layers, options);
  const guidance = renderGuidance(await source, selection);
  const result = compose(layers, { ...options, guidance });
  expect(new Map([...result.files].filter(([path]) => !guidance.has(path)))).toEqual(
    baseline.files,
  );
  expect(Object.keys(result.report.filesByLayer)).toContain('guidance');
  for (const [path, bytes] of guidance)
    expect(result.files.get(path)).toEqual({ bytes: Uint8Array.from(bytes), mode: 0o644 });
  expect(() =>
    compose(layers, { ...options, guidance: new Map([['package.json', Buffer.from('{}\n')]]) }),
  ).toThrow(LayerCollisionError);
  layers[0]!.files = new Map([
    ...layers[0]!.files,
    ['AGENTS.md', Buffer.from('layer instructions\n')],
  ]);
  expect(() => compose(layers, { ...options, guidance })).toThrow(
    'between layers base and guidance',
  );
  for (const path of ['../outside', '.git/config'])
    expect(() =>
      compose(layers, { ...options, guidance: new Map([[path, Buffer.from('bad\n')]]) }),
    ).toThrow('path');
  expect(() =>
    compose(layers, { ...options, guidance: new Map([['line.txt', Buffer.from('bad\r\n')]]) }),
  ).toThrow('LF');
});

test('the loader refuses CRLF, symlinks, non-regular files and missing sources', async () => {
  const root = await scratch();
  await writeFile(join(root, 'SKILL.md'), 'line\n');
  expect(text((await loadGuidanceSource(root)).get('SKILL.md'))).toBe('line\n');
  await writeFile(join(root, 'SKILL.md'), 'line\r\n');
  await expect(loadGuidanceSource(root)).rejects.toThrow('LF');
  await writeFile(join(root, 'SKILL.md'), 'line\n');
  await symlink(join(root, 'SKILL.md'), join(root, 'link.md'));
  await expect(loadGuidanceSource(root)).rejects.toThrow('symlink');
  await rm(join(root, 'link.md'));
  await symlink(root, join(root, 'linked-root'));
  await expect(loadGuidanceSource(join(root, 'linked-root'))).rejects.toThrow('symlink');
  await rm(join(root, 'linked-root'));
  execFileSync('mkfifo', [join(root, 'pipe')]);
  await expect(loadGuidanceSource(root)).rejects.toThrow('regular');
  await expect(loadGuidanceSource(join(root, 'absent'))).rejects.toThrow(GuidanceError);
});

test('written guidance consists of real files with fixed modes', async () => {
  const root = await scratch();
  const rendered = renderGuidance(await source, selection);
  await mkdir(join(root, 'app'));
  const files = new Map([...rendered].map(([path, bytes]) => [path, { bytes, mode: 0o644 }]));
  await writeProject(await planWrite(files, join(root, 'app'), root));
  for (const [path, bytes] of rendered) {
    const actual = join(root, 'app', path);
    const stat = await lstat(actual);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o644);
    expect(await readFile(actual)).toEqual(Buffer.from(bytes));
  }
});

test('only plain reference pages are copied into a project', async () => {
  const input = new Map(await source);
  input.set('references/.DS_Store', Buffer.from('noise'));
  input.set('references/Notes.md', Buffer.from('# Notes\n'));
  input.set('references/nested/extra.md', Buffer.from('# Extra\n'));
  const files = renderGuidance(input, selection);
  expect([...files.keys()].filter((path) => /DS_Store|Notes|nested/.test(path))).toEqual([]);
  expect(files).toEqual(renderGuidance(await source, selection));
});
