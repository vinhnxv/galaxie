// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import ts from '@typescript/typescript6';

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--refresh-citations')) {
  console.error('Usage: node scripts/check-docs.ts [--refresh-citations]');
  process.exit(2);
}
const refreshCitations = args[0] === '--refresh-citations';
const citationUpdates = new Map<string, string>();

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

// A Markdown code span cannot cross a blank line, so an unpaired backtick must not
// hide later paragraphs from the claim and citation checks.
function withoutCode(content: string): string {
  return content
    .split(/(\n[ \t]*\n)/)
    .map((part, index) =>
      index % 2 === 1 ? part : part.replace(/(?<!`)(`+)(?!`)([\s\S]*?)(?<!`)\1(?!`)/g, mask),
    )
    .join('');
}

interface Heading {
  level: number;
  text: string;
  line: number;
}

function headings(lines: readonly string[]): Heading[] {
  const result: Heading[] = [];
  const frontmatterEnd =
    lines[0]?.trimEnd() === '---'
      ? lines.findIndex((line, index) => index > 0 && /^---\s*$/.test(line))
      : -1;
  for (const [index, line] of lines.entries()) {
    if (frontmatterEnd > 0 && index <= frontmatterEnd) continue;
    const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading?.[1] && heading[2]) {
      result.push({ level: heading[1].length, text: heading[2], line: index });
    } else if (index > 0 && /^ {0,3}(?:=+|-+)\s*$/.test(line)) {
      const previous = lines[index - 1] ?? '';
      if (
        /^ {0,3}\S/.test(previous) &&
        !/^ {0,3}(?:[-+*]\s|\d+[.)]\s|#{1,6}(?:\s|$)|>|<|[-=]+\s*$|(?:[*_]\s*){3,}$)/.test(previous)
      )
        result.push({
          level: line.trim().startsWith('=') ? 1 : 2,
          text: previous.trim(),
          line: index - 1,
        });
    }
  }
  return result;
}

function sectionExtent(
  lines: readonly string[],
  titles: readonly Heading[],
  heading: Heading,
): { start: number; end: number } {
  const start = heading.line + (/^ {0,3}#{1,6}\s/.test(lines[heading.line] ?? '') ? 1 : 2);
  const next = titles.find((item) => item.line > heading.line && item.level <= heading.level);
  return { start, end: next?.line ?? lines.length };
}

function citationHash(
  file: string,
  line: number,
  target: string,
  title: string,
): string | undefined {
  if (!tracked.has(target) || !existsSync(target) || !statSync(target).isFile()) {
    problem(file, line, `missing citation file: ${target}`);
    return;
  }
  const raw = readFileSync(target, 'utf8').split(/\r?\n/);
  const masked = prose(raw.join('\n'));
  const titles = headings(masked);
  const matches = titles.filter((item) => item.text === title);
  if (matches.length !== 1) {
    problem(
      file,
      line,
      `${matches.length === 0 ? 'missing' : 'ambiguous'} heading: ${target}#${title}`,
    );
    return;
  }
  const heading = matches[0];
  if (heading === undefined) return;
  const { start, end } = sectionExtent(masked, titles, heading);
  const body = raw
    .slice(start, end)
    .map((value) => value.trimEnd())
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
  if (body === '') {
    problem(file, line, `empty citation section: ${target}#${title}`);
    return;
  }
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

function checkCitations(file: string, source: string, content: string): void {
  const updates = new Map<number, string>();
  const raw = source.split(/\r?\n/);
  for (const [index, line] of content.split('\n').entries()) {
    if (!/<!--\s*galaxie:cite/i.test(line)) continue;
    const match =
      /^\s*<!-- galaxie:cite path="([^"]+)" heading="([^"]+)" sha256="([a-f\d]{64})" -->\s*$/.exec(
        raw[index] ?? '',
      );
    if (match === null) {
      problem(
        file,
        index + 1,
        'invalid citation: expected path, heading and a 64-character sha256',
      );
      continue;
    }
    const [, target, title, expected] = match;
    if (target === undefined || title === undefined || expected === undefined) continue;
    const actual = citationHash(file, index + 1, target, title);
    if (actual === undefined || actual === expected) continue;
    if (refreshCitations) updates.set(index, actual);
    else
      problem(
        file,
        index + 1,
        `citation hash mismatch: ${target}#${title}; review the guidance, then run node scripts/check-docs.ts --refresh-citations`,
      );
  }
  if (updates.size > 0) {
    let index = 0;
    citationUpdates.set(
      file,
      source.replace(/[^\n]*(?:\n|$)/g, (line) => {
        const hash = updates.get(index++);
        return hash === undefined ? line : line.replace(/sha256="[a-f\d]{64}"/, `sha256="${hash}"`);
      }),
    );
  }
}

function checkClaims(file: string, content: string): void {
  if (!/^(?:skills\/galaxie\/|templates\/).*\.md$/i.test(file)) return;
  const label = '`(?:secure|secured|compliant|certified)`';
  const prohibition = new RegExp(
    '\\bNever\\s+call\\s+galaxie\\s+or\\s+generated\\s+apps\\s+' +
      `${label}(?:(?:,\\s*(?:(?:or|and)\\s+)?|\\s+(?:or|and)\\s+)${label})*`,
    'gi',
  );
  const checked = content
    .split(/(\n[ \t]*\n)/)
    .map((paragraph) =>
      paragraph.replace(prohibition, (rule) => rule.replace(new RegExp(label, 'gi'), mask)),
    )
    .join('');
  for (const [index, line] of checked.split('\n').entries()) {
    for (const match of line.matchAll(/\b(?:secure|secured|compliant|certified)\b/gi)) {
      problem(
        file,
        index + 1,
        `banned claim: ${match[0]}; describe controls and documented limits`,
      );
    }
  }
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

function tracingKeys(source: string): Set<string> {
  const tree = ts.createSourceFile('tracing.ts', source, ts.ScriptTarget.Latest);
  const declarations = new Map<string, ts.VariableDeclaration[]>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const name = node.name.text;
      if (name === 'ALLOWED' || name === 'text')
        declarations.set(name, [...(declarations.get(name) ?? []), node]);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  const keys = new Set<string>();
  for (const name of ['ALLOWED', 'text']) {
    const candidates = declarations.get(name) ?? [];
    const initializer = candidates.length === 1 ? candidates[0]?.initializer : undefined;
    let literals: readonly ts.Node[] = [];
    if (
      name === 'ALLOWED' &&
      initializer !== undefined &&
      ts.isNewExpression(initializer) &&
      ts.isIdentifier(initializer.expression) &&
      initializer.expression.text === 'Set' &&
      initializer.arguments?.length === 1
    ) {
      const argument = initializer.arguments[0];
      if (argument !== undefined && ts.isArrayLiteralExpression(argument))
        literals = argument.elements;
    } else if (name === 'text' && initializer !== undefined && ts.isArrowFunction(initializer)) {
      const type = initializer.parameters.find(
        (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === 'key',
      )?.type;
      if (type !== undefined)
        literals = (ts.isUnionTypeNode(type) ? type.types : [type]).map((item) =>
          ts.isLiteralTypeNode(item) ? item.literal : item,
        );
    }
    if (literals.length === 0 || !literals.every(ts.isStringLiteral))
      throw new Error(
        `cannot extract tracing attributes from ${name}: expected non-empty string literals`,
      );
    for (const literal of literals) {
      if (literal.text === '')
        throw new Error(`cannot extract tracing attributes from ${name}: empty key`);
      keys.add(literal.text);
    }
  }
  return keys;
}

function checkTracingTable(): void {
  const source = 'packages/core/src/tracing.ts';
  const guide = 'docs/guides/tracing.md';
  const sourcePresent = required(source);
  const guidePresent = required(guide);
  if (!sourcePresent || !guidePresent) return;
  let keys: Set<string>;
  try {
    keys = tracingKeys(readFileSync(source, 'utf8'));
  } catch (error) {
    problem(source, 1, error instanceof Error ? error.message : String(error));
    return;
  }
  const lines = prose(readFileSync(guide, 'utf8'));
  const header = lines.findIndex((line) => /^\| Span or outcome \|/.test(line));
  if (header < 0) {
    problem(guide, 1, 'missing tracing attribute table');
    return;
  }
  const documented = new Set<string>();
  for (let index = header + 2; index < lines.length; index++) {
    const line = lines[index] ?? '';
    if (!line.startsWith('|')) break;
    const [, row, attributes] = line.split('|');
    for (const match of (attributes ?? '').replace(/\([^)]*\)/g, '').matchAll(/`([^`]+)`/g)) {
      const key = match[1];
      if (key === undefined) continue;
      documented.add(key);
      if (!keys.has(key))
        problem(guide, index + 1, `unknown tracing attribute: ${key}; row: ${row?.trim()}`);
    }
  }
  for (const key of keys)
    if (!documented.has(key)) problem(guide, header + 1, `missing tracing attribute: ${key}`);
}

checkTracingTable();

for (const file of files.filter((file) => /\.md$/i.test(file) || file === 'llms.txt')) {
  if (!existsSync(file)) {
    problem(file, 1, 'missing required file');
    continue;
  }
  const source = readFileSync(file, 'utf8');
  const lines = prose(source);
  const text = withoutCode(lines.join('\n'));
  checkCitations(file, source, text);
  checkClaims(file, lines.join('\n'));
  const refs = new Map<string, string>();
  const content = text.replace(
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
} else if (refreshCitations) {
  for (const [file, content] of citationUpdates) writeFileSync(file, content);
}
