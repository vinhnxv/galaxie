// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { basename, isAbsolute, parse, resolve } from 'node:path';

export class ProjectPathError extends Error {}

export function validateOutputPath(path: string): string {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    isAbsolute(path) ||
    /[\\\0:]/.test(path) ||
    path
      .split('/')
      .some((part) => part === '' || part === '.' || part === '..' || part.toLowerCase() === '.git')
  )
    throw new ProjectPathError('The output path is invalid.');
  return path;
}

export function validateProjectName(name: string): string {
  if (
    !/^[a-z0-9][a-z0-9._-]*$/.test(name) ||
    name.length > 214 ||
    name === 'node_modules' ||
    name === 'favicon.ico'
  )
    throw new ProjectPathError('The project name must be a lowercase npm package name.');
  return name;
}

export function validateTarget(target: string): string {
  if (target.length === 0 || /[\\\0]/.test(target) || target.split('/').includes('..'))
    throw new ProjectPathError('The target path is invalid.');
  const absolute = resolve(target);
  if (absolute === parse(absolute).root)
    throw new ProjectPathError('The filesystem root is not a project target.');
  return absolute;
}

export function projectName(target: string): string {
  return validateProjectName(basename(validateTarget(target)));
}
