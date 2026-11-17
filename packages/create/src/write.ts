// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { Stats } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { ProjectFile } from './compose.js';
import { validateOutputPath, validateTarget } from './paths.js';

export class ProjectWriteError extends Error {}
interface Identity {
  readonly dev: number;
  readonly ino: number;
}
export interface WritePlan {
  readonly target: string;
  readonly trustedRoot: string;
  readonly rootIdentity: Identity;
  readonly files: ReadonlyMap<string, ProjectFile>;
  readonly conflicts: readonly string[];
  readonly skipped: readonly string[];
}
const protectedNames = new Set(['agents.md', 'claude.md']);
const protectedPath = (path: string): boolean => protectedNames.has(path.toLowerCase());
const same = (left: Identity, right: Identity): boolean =>
  left.dev === right.dev && left.ino === right.ino;
async function info(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new ProjectWriteError('The project path could not be inspected.');
  }
}
async function checkRoot(plan: WritePlan): Promise<void> {
  const stat = await info(plan.trustedRoot);
  if (stat?.isSymbolicLink()) throw new ProjectWriteError('A project path contains a symlink.');
  if (stat === undefined || !stat.isDirectory() || !same(stat, plan.rootIdentity))
    throw new ProjectWriteError('The trusted project directory changed.');
}
async function checkPath(plan: WritePlan, path: string): Promise<void> {
  await checkRoot(plan);
  let current = plan.trustedRoot;
  const components = relative(plan.trustedRoot, path)
    .split(sep)
    .filter((part) => part !== '');
  if (components.includes('..')) throw new ProjectWriteError('The output path leaves the target.');
  for (const [index, part] of components.entries()) {
    current = join(current, part);
    const stat = await info(current);
    if (stat?.isSymbolicLink()) throw new ProjectWriteError('A project path contains a symlink.');
    if (stat !== undefined && index < components.length - 1 && !stat.isDirectory())
      throw new ProjectWriteError('A project parent must be a directory.');
  }
}

// Every existing component between the trusted base (the working directory) and the target must be
// a real directory entry; a symlink in the middle of the path would redirect the whole project.
async function rejectLinkedComponents(base: string, absolute: string): Promise<void> {
  const parts = relative(resolve(base), absolute).split(sep);
  if (parts[0] === '..' || parts.some((part) => part === '')) return;
  let current = resolve(base);
  for (const part of parts) {
    current = join(current, part);
    const stat = await info(current);
    if (stat === undefined) return;
    if (stat.isSymbolicLink())
      throw new ProjectWriteError('The target or its parent is a symlink.');
  }
}

export async function planWrite(
  files: ReadonlyMap<string, ProjectFile>,
  target: string,
  base: string = process.cwd(),
): Promise<WritePlan> {
  const absolute = validateTarget(target);
  await rejectLinkedComponents(base, absolute);
  let ancestor = absolute;
  let existing = await info(ancestor);
  while (existing === undefined) {
    ancestor = dirname(ancestor);
    existing = await info(ancestor);
  }
  if (existing.isSymbolicLink())
    throw new ProjectWriteError('The target or its parent is a symlink.');
  if (!existing.isDirectory()) throw new ProjectWriteError('The target must be a directory.');
  const trustedRoot = await realpath(ancestor);
  const canonical = resolve(trustedRoot, relative(ancestor, absolute));
  const stat = await info(trustedRoot);
  if (stat === undefined) throw new ProjectWriteError('The target directory changed.');
  const conflicts: string[] = [];
  const skipped: string[] = [];
  const copied = new Map<string, ProjectFile>();
  const plan: WritePlan = {
    target: canonical,
    trustedRoot,
    rootIdentity: { dev: stat.dev, ino: stat.ino },
    files: copied,
    conflicts,
    skipped,
  };
  const names = (await info(canonical)) === undefined ? [] : await readdir(canonical);
  for (const [path, file] of [...files].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    validateOutputPath(path);
    if (protectedPath(path) && names.some((name) => name.toLowerCase() === path.toLowerCase())) {
      skipped.push(path);
      continue;
    }
    const full = resolve(canonical, path);
    try {
      await checkPath(plan, full);
    } catch (error) {
      if (
        error instanceof ProjectWriteError &&
        error.message === 'A project parent must be a directory.'
      ) {
        conflicts.push(path);
        continue;
      }
      throw error;
    }
    if ((await info(full)) !== undefined) conflicts.push(path);
    copied.set(path, { bytes: Uint8Array.from(file.bytes), mode: 0o644 });
  }
  return plan;
}

export async function writeProject(plan: WritePlan): Promise<void> {
  if (plan.conflicts.length > 0)
    throw new ProjectWriteError(`Existing output paths: ${plan.conflicts.join(', ')}.`);
  const createdFiles: Array<{ path: string; identity: Identity }> = [];
  const createdDirectories: Array<{ path: string; identity: Identity }> = [];
  const ensureDirectory = async (path: string): Promise<void> => {
    await checkPath(plan, path);
    let current = plan.trustedRoot;
    for (const part of relative(plan.trustedRoot, path)
      .split(sep)
      .filter((value) => value !== '')) {
      current = join(current, part);
      await checkPath(plan, current);
      let stat = await info(current);
      if (stat === undefined) {
        try {
          await mkdir(current, { mode: 0o755 });
        } catch {
          throw new ProjectWriteError('The project directory could not be created.');
        }
        stat = await lstat(current);
        createdDirectories.push({ path: current, identity: { dev: stat.dev, ino: stat.ino } });
        await chmod(current, 0o755);
      }
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new ProjectWriteError('A project parent must be a directory without a symlink.');
    }
  };
  try {
    await checkRoot(plan);
    await ensureDirectory(plan.target);
    for (const [path, file] of plan.files) {
      validateOutputPath(path);
      if (
        protectedPath(path) &&
        (await readdir(plan.target)).some((name) => name.toLowerCase() === path.toLowerCase())
      )
        continue;
      const full = resolve(plan.target, path);
      await ensureDirectory(dirname(full));
      await checkPath(plan, full);
      const handle = await open(full, 'wx', 0o644);
      try {
        const stat = await handle.stat();
        createdFiles.push({ path: full, identity: { dev: stat.dev, ino: stat.ino } });
        await handle.chmod(0o644);
        await handle.writeFile(file.bytes);
      } finally {
        await handle.close();
      }
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    const leftovers: string[] = [];
    const recordRollback = (path: string, failure: unknown): void => {
      const code = (failure as NodeJS.ErrnoException | null)?.code;
      if (code === 'ENOENT') return;
      rollbackErrors.push(failure);
      leftovers.push(
        `${relative(plan.target, path) || '.'}${typeof code === 'string' && /^[A-Z_]+$/.test(code) ? ` (${code})` : ''}`,
      );
    };
    for (const created of createdFiles.reverse()) {
      try {
        const stat = await lstat(created.path);
        if (stat.isFile() && same(stat, created.identity)) await unlink(created.path);
      } catch (failure) {
        recordRollback(created.path, failure);
      }
    }
    for (const created of createdDirectories.reverse()) {
      try {
        const stat = await lstat(created.path);
        if (stat.isDirectory() && same(stat, created.identity)) await rmdir(created.path);
      } catch (failure) {
        recordRollback(created.path, failure);
      }
    }
    const message =
      error instanceof ProjectWriteError
        ? error.message
        : 'The project could not be written without replacing an existing path.';
    if (rollbackErrors.length > 0)
      throw new ProjectWriteError(
        `${message} Rollback could not remove: ${leftovers.join(', ')}.`,
        {
          cause: new AggregateError([error, ...rollbackErrors]),
        },
      );
    if (error instanceof ProjectWriteError) throw error;
    throw new ProjectWriteError(message, { cause: error });
  }
}
