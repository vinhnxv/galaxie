// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateOutputPath } from './paths.js';

export class GuidanceError extends Error {}

export async function loadGuidanceSource(
  directory: string,
): Promise<ReadonlyMap<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  const visit = async (full: string, prefix: string): Promise<void> => {
    const stat = await lstat(full);
    if (stat.isSymbolicLink()) throw new GuidanceError('Guidance symlinks are not supported.');
    if (!stat.isDirectory()) throw new GuidanceError('The guidance source must be a directory.');
    for (const entry of (await readdir(full)).sort()) {
      const path = prefix + entry;
      validateOutputPath(path);
      const child = join(full, entry);
      const info = await lstat(child);
      if (info.isSymbolicLink()) throw new GuidanceError('Guidance symlinks are not supported.');
      if (info.isDirectory()) await visit(child, `${path}/`);
      else if (info.isFile()) {
        const bytes = await readFile(child);
        if (bytes.includes(Buffer.from('\r\n')))
          throw new GuidanceError('Guidance files must use LF line endings.');
        files.set(path, bytes);
      } else throw new GuidanceError('Guidance entries must be regular files or directories.');
    }
  };
  try {
    await visit(directory, '');
  } catch (error) {
    if (error instanceof GuidanceError) throw error;
    throw new GuidanceError('The guidance source could not be loaded.');
  }
  return files;
}

function required(source: ReadonlyMap<string, Uint8Array>, path: string): Uint8Array {
  const bytes = source.get(path);
  if (bytes === undefined) throw new GuidanceError(`Missing guidance file: ${path}.`);
  return bytes;
}

function summary(source: ReadonlyMap<string, Uint8Array>, path: string, limit: number): string {
  const content = Buffer.from(required(source, path)).toString('utf8');
  const start = '<!-- galaxie:summary:start -->';
  const end = '<!-- galaxie:summary:end -->';
  if (content.split(start).length !== 2 || content.split(end).length !== 2)
    throw new GuidanceError(`Guidance ${path} requires exactly one summary span.`);
  const from = content.indexOf(start) + start.length;
  const to = content.indexOf(end);
  const body = content.slice(from, to).trim();
  if (to < from || body.length === 0 || Buffer.byteLength(body) > limit)
    throw new GuidanceError(`Guidance ${path} summary must contain 1 to ${limit} bytes.`);
  return body;
}

export function renderGuidance(
  source: ReadonlyMap<string, Uint8Array>,
  selection: { readonly kind: string; readonly framework: string },
): ReadonlyMap<string, Uint8Array> {
  const skill = Buffer.from(required(source, 'SKILL.md')).toString('utf8');
  const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(skill)?.[1];
  const versions = frontmatter?.match(/^version: (.+)$/gm) ?? [];
  const version = versions[0]?.slice('version: '.length);
  if (
    versions.length !== 1 ||
    version === undefined ||
    !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version)
  )
    throw new GuidanceError('Guidance SKILL.md requires one exact version in its frontmatter.');
  const kind = `references/kind-${selection.kind}.md`;
  const framework = `references/framework-${selection.framework}.md`;
  const agents = `<!-- galaxie:begin guidance=1 skill=${version} -->
# Coding with galaxie

Read [the galaxie skill](.agents/skills/galaxie/SKILL.md) and the references present
before editing. The same skill is available in .claude/skills/galaxie.
Compare its version with the installed @galaxie-ai/core; stop on a mismatch.

## Rules to preserve

${summary(source, 'SKILL.md', 1800)}

## Project kind: ${selection.kind}

${summary(source, kind, 600)}

## Framework: ${selection.framework}

${summary(source, framework, 600)}

## Verify changes

Use the package manager in package.json. Run npm run check and npm run build
(or the equivalent for that manager); gateway projects also have npm run build:server.
Keep the generated CSP and Trusted Types assertions. Exercise changed flows with mocks.
<!-- galaxie:end -->
`;
  if (Buffer.byteLength(agents) >= 8192)
    throw new GuidanceError('Generated AGENTS.md must stay under 8192 bytes.');
  const files = new Map<string, Uint8Array>([
    ['AGENTS.md', Buffer.from(agents)],
    ['CLAUDE.md', Buffer.from('@AGENTS.md\n')],
  ]);
  const selected = [
    'SKILL.md',
    ...[...source.keys()].filter(
      (path) =>
        path.startsWith('references/') &&
        (!/^references\/(?:kind|framework)-/.test(path) || path === kind || path === framework),
    ),
  ];
  for (const path of selected) {
    validateOutputPath(path);
    for (const directory of ['.agents', '.claude'])
      files.set(`${directory}/skills/galaxie/${path}`, Uint8Array.from(required(source, path)));
  }
  return new Map([...files].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
}
