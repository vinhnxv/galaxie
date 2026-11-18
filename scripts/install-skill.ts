// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const exactVersion = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;
const source = fileURLToPath(new URL('../skills/galaxie/', import.meta.url));

function files(directory: string): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  function visit(path: string, prefix: string): void {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Refusing symlink: ${path}`);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name), `${prefix}${name}/`);
    } else if (stat.isFile()) result.set(prefix.slice(0, -1), readFileSync(path));
    else throw new Error(`Expected a regular file or directory: ${path}`);
  }
  visit(directory, '');
  return result;
}

function coreVersion(app: string, override: string | undefined): unknown {
  const installed = join(app, 'node_modules/@galaxie-ai/core/package.json');
  try {
    return (JSON.parse(readFileSync(installed, 'utf8')) as { version?: unknown }).version;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (override !== undefined) return override;
  try {
    const manifest = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    const declared =
      manifest.dependencies?.['@galaxie-ai/core'] ?? manifest.devDependencies?.['@galaxie-ai/core'];
    if (typeof declared === 'string' && exactVersion.test(declared))
      console.warn(
        'Note: No installed @galaxie-ai/core was found; using the declared exact version without verifying an installation. Pass --core-version with a verified version for hoisted installs.',
      );
    return declared;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
}

function destination(app: string, path: string): string {
  let current = app;
  for (const part of path.split('/')) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat === undefined) continue;
    if (stat.isSymbolicLink()) throw new Error(`Refusing symlink: ${current}`);
    if (!stat.isDirectory()) throw new Error(`Expected a skill directory: ${current}`);
    const bounded = relative(app, realpathSync(current));
    if (bounded === '..' || bounded.startsWith(`..${sep}`))
      throw new Error(`Skill destination escapes the app: ${current}`);
  }
  return current;
}

export function install(
  app: string,
  options: { readonly coreVersion?: string; readonly replaceSkill?: boolean } = {},
): void {
  const root = realpathSync(resolve(app));
  if (!lstatSync(root).isDirectory()) throw new Error('The app must be a directory.');
  const skill = readFileSync(join(source, 'SKILL.md'));
  const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(skill.toString('utf8'))?.[1];
  const versions = frontmatter?.match(/^version: (.+)$/gm) ?? [];
  const version = versions[0]?.slice('version: '.length);
  const core = coreVersion(root, options.coreVersion);
  if (
    versions.length !== 1 ||
    version === undefined ||
    !exactVersion.test(version) ||
    typeof core !== 'string' ||
    !exactVersion.test(core) ||
    core !== version
  )
    throw new Error(
      `Skill version mismatch or unresolved version: skill=${version ?? 'unknown'}, core=${String(core ?? 'missing')}. Use an exact matching @galaxie-ai/core version.`,
    );

  const sourceInfo = lstatSync(source);
  if (sourceInfo.isSymbolicLink() || lstatSync(join(source, 'SKILL.md')).isSymbolicLink())
    throw new Error('Refusing a symlink in the skill source.');
  const references = join(source, 'references');
  if (!lstatSync(references).isDirectory())
    throw new Error('Skill references must be a directory.');
  const expected = new Map([
    ['SKILL.md', skill],
    ...[...files(references)]
      .filter(([path]) => /^[a-z0-9-]+\.md$/.test(path))
      .map(([path, bytes]): [string, Buffer] => [`references/${path}`, bytes]),
  ]);
  const targets = ['.agents/skills/galaxie', '.claude/skills/galaxie'].map((path) => {
    const target = destination(root, path);
    const exists = lstatSync(target, { throwIfNoEntry: false }) !== undefined;
    const existing = exists ? files(target) : new Map<string, Buffer>();
    const equal =
      exists &&
      existing.size === expected.size &&
      [...expected].every(([name, bytes]) => existing.get(name)?.equals(bytes));
    if (exists && !equal && !options.replaceSkill)
      throw new Error(
        `Skill differs at ${path}; pass --replace-skill to replace only the galaxie skill directories.`,
      );
    return { target, exists, equal };
  });
  // Stage every changed copy beside its target first, so a failed write leaves no half skill.
  const pending = targets.filter(({ equal }) => !equal);
  const staged: string[] = [];
  try {
    for (const { target } of pending) {
      const stage = `${target}.staging-${process.pid}`;
      staged.push(stage);
      for (const [path, bytes] of expected) {
        const output = join(stage, path);
        mkdirSync(dirname(output), { recursive: true });
        writeFileSync(output, bytes, { flag: 'wx', mode: 0o644 });
      }
    }
  } catch (error) {
    for (const stage of staged) rmSync(stage, { recursive: true, force: true });
    throw error;
  }
  for (const [index, { target, exists }] of pending.entries()) {
    if (exists) rmSync(target, { recursive: true });
    renameSync(staged[index] ?? '', target);
  }
}

if (
  import.meta.main ||
  (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
) {
  const usage =
    'Usage: node scripts/install-skill.ts <app-directory> [--core-version <version>] [--replace-skill]';
  const args = process.argv.slice(2);
  const app = args.shift();
  let coreVersion: string | undefined;
  let replaceSkill = false;
  let valid = app !== undefined && !app.startsWith('-');
  while (args.length > 0 && valid) {
    const flag = args.shift();
    if (flag === '--replace-skill' && !replaceSkill) replaceSkill = true;
    else if (flag === '--core-version' && coreVersion === undefined) {
      coreVersion = args.shift();
      valid = coreVersion !== undefined && exactVersion.test(coreVersion);
    } else valid = false;
  }
  if (!valid || app === undefined) {
    console.error(usage);
    process.exitCode = 2;
  } else {
    try {
      const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
      if (major < 22 || (major === 22 && minor < 18)) throw new Error('Node >=22.18 is required.');
      install(app, { ...(coreVersion === undefined ? {} : { coreVersion }), replaceSkill });
      console.log(
        'Installed matching galaxie skill in .agents/skills/galaxie and .claude/skills/galaxie.',
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
