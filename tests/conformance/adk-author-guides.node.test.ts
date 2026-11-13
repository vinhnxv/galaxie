// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const root = new URL('../../', import.meta.url);
const snippetDirectory = 'packages/adapter-adk/test/guide-snippets/';
const python = 'python/galaxie/tests/test_adk_author_guides.py';
const go = 'go/galaxie/author_guides_test.go';
const registry = [
  ['input-agent-js', `${snippetDirectory}input-agent.ts`],
  ['input-host-js', `${snippetDirectory}input-host.ts`],
  ['model-before-js', `${snippetDirectory}model-before.ts`],
  ['model-after-js', `${snippetDirectory}model-after.ts`],
  ['toolset-js', `${snippetDirectory}toolset-flat.ts`],
  ['planner-before-js', `${snippetDirectory}planner-before.ts`],
  ['input-agent-py', python],
  ['model-string-py', python],
  ['toolset-py', python],
  ['planner-before-py', python],
  ['model-go', go],
  ['toolset-go', go],
] as const;
const guides = ['docs/guides/adk-request-input.md', 'docs/guides/adk-models-and-tools.md'];

function normalize(text: string): string {
  const lines = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd());
  while (lines[0] === '') lines.shift();
  while (lines.at(-1) === '') lines.pop();
  const indentation = Math.min(
    ...lines.filter(Boolean).map((line) => line.match(/^\s*/)?.[0].length ?? 0),
  );
  return lines.map((line) => line.slice(indentation)).join('\n');
}

function sourceText(text: string, id: string, path: string): string {
  if (path.endsWith('.ts'))
    return text
      .replace(/^\/\/ SPDX-[^\n]*\n/gm, '')
      .replaceAll("'../../src/index.js'", "'@galaxie-ai/adapter-adk'");
  const prefix = path.endsWith('.py') ? '#' : '//';
  const begin = `${prefix} guide:begin ${id}`;
  const end = `${prefix} guide:end ${id}`;
  const lines = text.split('\n');
  const first = lines.indexOf(begin);
  const last = lines.indexOf(end);
  if (
    first < 0 ||
    last <= first ||
    lines.lastIndexOf(begin) !== first ||
    lines.lastIndexOf(end) !== last
  )
    throw new Error(`Missing or duplicate region markers for ${id} in ${path}.`);
  return lines.slice(first + 1, last).join('\n');
}

function checkGuide(
  markdown: string,
  guide: string,
  sources: ReadonlyMap<string, string>,
): string[] {
  const ids: string[] = [];
  for (const block of markdown.matchAll(/^```([^\n]*)\n([\s\S]*?)^```[ \t]*$/gm)) {
    const language = block[1]?.trim();
    if (!['ts', 'python', 'go'].includes(language ?? '')) continue;
    const id = markdown.slice(0, block.index).match(/<!-- snippet: ([\w-]+) -->\s*$/)?.[1];
    if (id === undefined) throw new Error(`Unmarked ${language} fence in ${guide}.`);
    const expected = sources.get(id);
    if (expected === undefined) throw new Error(`Unregistered snippet ${id} in ${guide}.`);
    expect(normalize(block[2] ?? ''), `${id} in ${guide}`).toBe(normalize(expected));
    ids.push(id);
  }
  return ids;
}

test('every author guide snippet equals its executed source exactly once', () => {
  expect(new Set(registry.map(([id]) => id)).size).toBe(registry.length);
  const sources = new Map(
    registry.map(([id, path]) => [
      id,
      sourceText(readFileSync(new URL(path, root), 'utf8'), id, path),
    ]),
  );
  const used = guides.flatMap((guide) =>
    checkGuide(readFileSync(new URL(guide, root), 'utf8'), guide, sources),
  );
  expect(used.toSorted()).toEqual([...sources.keys()].toSorted());
  expect(readdirSync(fileURLToPath(new URL(snippetDirectory, root))).toSorted()).toEqual(
    registry
      .filter(([, path]) => path.startsWith(snippetDirectory))
      .map(([, path]) => path.slice(snippetDirectory.length))
      .toSorted(),
  );
});

test('a changed snippet fails with its id and guide path', () => {
  expect(() =>
    checkGuide(
      '<!-- snippet: sample -->\n```ts\nchanged\n```',
      'example.md',
      new Map([['sample', 'original']]),
    ),
  ).toThrow('sample in example.md');
});

test('unmarked executable fences fail while text fences are exempt', () => {
  expect(() => checkGuide('```python\npass\n```', 'example.md', new Map())).toThrow(
    'Unmarked python fence in example.md',
  );
  expect(checkGuide('```text\nexample\n```', 'example.md', new Map())).toEqual([]);
});

test('a registered region without its end marker fails', () => {
  expect(() => sourceText('# guide:begin sample\npass', 'sample', 'example.py')).toThrow(
    'Missing or duplicate region markers for sample in example.py',
  );
});
