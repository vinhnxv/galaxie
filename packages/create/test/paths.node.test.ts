// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import {
  ProjectPathError,
  projectName,
  validateOutputPath,
  validateProjectName,
  validateTarget,
} from '../src/paths.js';

test.each(['../x', 'a/../x', 'a/./x', '/etc/x', 'a\\b', 'a//b', '.git/config', 'a\0b', 'C:/x'])(
  'rejects an unsafe output path %j',
  (path) => {
    expect(() => validateOutputPath(path)).toThrow(ProjectPathError);
    expect(validateOutputPath('src/main.tsx')).toBe('src/main.tsx');
  },
);
test.each(['Uppercase', '.hidden', 'spaces here', 'node_modules', 'favicon.ico', 'x'.repeat(215)])(
  'rejects invalid npm names %j',
  (name) => {
    expect(() => validateProjectName(name)).toThrow('lowercase npm package name');
    expect(validateProjectName('my-app_1')).toBe('my-app_1');
  },
);
test('target checking rejects root, NUL and traversal while deriving a valid name', () => {
  for (const target of ['/', '../outside', 'a/../outside', 'a\0b'])
    expect(() => validateTarget(target)).toThrow(ProjectPathError);
  expect(projectName('nested/my-app')).toBe('my-app');
});
