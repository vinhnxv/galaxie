// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter((file) => file && !/^(?:internal\/|docs\/plans\/|node_modules\/)/.test(file));
const tracked = new Set(files);
const problems: string[] = [];

function problem(file: string, line: number, message: string): void {
  problems.push(`${file}:${line}: ${message}`);
}

function required(file: string): boolean {
  if (tracked.has(file) && existsSync(file)) return true;
  problem(file, 1, 'missing required file');
  return false;
}

function prose(content: string): string[] {
  let fence: string | undefined;
  return content.split(/\r?\n/).map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence !== undefined) {
      if (
        marker !== undefined &&
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        line.trim() === marker
      )
        fence = undefined;
      return '';
    }
    if (marker !== undefined) {
      fence = marker;
      return '';
    }
    return line;
  });
}

function mask(content: string): string {
  return content.replace(/[^\n]/g, ' ');
}

function withoutCode(content: string): string {
  return content.replace(/(?<!`)(`+)(?!`)([\s\S]*?)(?<!`)\1(?!`)/g, mask);
}

function headings(lines: readonly string[]): { level: number; text: string }[] {
  const result: { level: number; text: string }[] = [];
  for (const [index, line] of lines.entries()) {
    const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading?.[1] && heading[2]) {
      result.push({ level: heading[1].length, text: heading[2] });
    } else if (index > 0 && /^ {0,3}(?:=+|-+)\s*$/.test(line)) {
      const previous = lines[index - 1]?.trim();
      if (previous) result.push({ level: line.trim().startsWith('=') ? 1 : 2, text: previous });
    }
  }
  return result;
}

function slugs(lines: readonly string[]): Set<string> {
  const used = new Set<string>();
  for (const { text } of headings(lines)) {
    const base = text
      .toLowerCase()
      .replace(/<[^>]*>/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, '')
      .replace(/ /g, '-');
    let slug = base;
    let suffix = 0;
    while (used.has(slug)) slug = `${base}-${++suffix}`;
    used.add(slug);
  }
  return used;
}

// A Markdown destination can be angle-delimited, or have balanced parentheses.
function destination(text: string): string {
  const value = text.trimStart();
  if (value.startsWith('<')) return value.slice(1, value.indexOf('>'));
  let depth = 0;
  let end = 0;
  for (; end < value.length; end++) {
    const character = value[end];
    if (character === '\\') {
      end++;
      continue;
    }
    if (character === '(') depth++;
    if (character === ')') {
      if (depth === 0) break;
      depth--;
    }
    if (/\s/.test(character ?? '') && depth === 0) break;
  }
  return value.slice(0, end).replace(/\\([() ])/g, '$1');
}

const headingCache = new Map<string, Set<string>>();
function checkLink(file: string, line: number, target: string): void {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) return;
  const hash = target.indexOf('#');
  const path = (hash < 0 ? target : target.slice(0, hash)).split('?')[0] ?? '';
  let decoded: string;
  let fragment: string;
  try {
    decoded = decodeURIComponent(path);
    fragment = decodeURIComponent(hash < 0 ? '' : target.slice(hash + 1));
  } catch {
    problem(file, line, `invalid target encoding: ${target}`);
    return;
  }
  const full = path === '' ? resolve(file) : resolve(dirname(file), decoded);
  if (!existsSync(full)) {
    problem(file, line, `missing target: ${target}`);
  } else if (fragment !== '' && (path === '' || extname(full).toLowerCase() === '.md')) {
    let anchors = headingCache.get(full);
    if (anchors === undefined) {
      anchors = slugs(prose(readFileSync(full, 'utf8')));
      headingCache.set(full, anchors);
    }
    if (!anchors.has(fragment)) problem(file, line, `missing heading: ${target}`);
  }
}

function reference(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

for (const file of files.filter((file) => /\.md$/i.test(file) || file === 'llms.txt')) {
  if (!existsSync(file)) {
    problem(file, 1, 'missing required file');
    continue;
  }
  const lines = prose(readFileSync(file, 'utf8'));
  const refs = new Map<string, string>();
  const content = withoutCode(lines.join('\n')).replace(
    /^ {0,3}\[([^\]\n]+)\]:[ \t]*(?:\n[ \t]*)?(.+)$/gm,
    (definition: string, label: string, target: string) => {
      const key = reference(label);
      if (!refs.has(key)) refs.set(key, destination(target));
      return mask(definition);
    },
  );
  const openings: number[] = [];
  for (let index = 0; index < content.length; index++) {
    if (content[index] === '\\') {
      index++;
      continue;
    }
    if (content[index] === '[') openings.push(index);
    if (content[index] !== ']') continue;
    const start = openings.pop();
    if (start === undefined) continue;
    const label = content.slice(start + 1, index);
    let target: string | undefined;
    if (content[index + 1] === '(') target = destination(content.slice(index + 2));
    else if (content[index + 1] === '[') {
      const end = content.indexOf(']', index + 2);
      if (end !== -1) {
        target = refs.get(reference(content.slice(index + 2, end) || label));
        index = end;
      }
    } else target = refs.get(reference(label));
    if (target !== undefined) checkLink(file, content.slice(0, start).split('\n').length, target);
  }
  if (/^packages\/[^/]+\/AGENTS\.md$/.test(file)) {
    const titles = new Set(
      headings(lines)
        .filter((item) => item.level === 2)
        .map((item) => item.text),
    );
    for (const title of ['Purpose', 'Entry points', 'Do', 'Never', 'Limits', 'Tests']) {
      if (!titles.has(title)) problem(file, 1, `missing section: ${title}`);
    }
  }
  if (file === 'llms.txt') {
    const titles = headings(lines);
    if (!titles.some((item) => item.level === 1)) problem(file, 1, 'missing H1');
    if (!lines.some((line) => /^>\s+\S/.test(line))) problem(file, 1, 'missing blockquote summary');
    if (!titles.some((item) => item.level === 2)) problem(file, 1, 'missing H2 section');
  }
}

for (const file of files.filter((file) => /^packages\/[^/]+\/package\.json$/.test(file))) {
  required(`${dirname(file)}/AGENTS.md`);
  required(`${dirname(file)}/README.md`);
}
required('llms.txt');

if (problems.length > 0) {
  console.error([...new Set(problems)].join('\n'));
  process.exitCode = 1;
}
