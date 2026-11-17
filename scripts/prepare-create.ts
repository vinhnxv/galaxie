// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { cp, rm } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const clean = process.argv[2] === '--clean';
if (process.argv.length !== (clean ? 3 : 2))
  throw new Error('Usage: node scripts/prepare-create.ts [--clean]');
for (const path of ['templates', 'skills/galaxie']) {
  const target = new URL(`packages/create/${path}`, root);
  await rm(target, { recursive: true, force: true });
  if (!clean) await cp(new URL(path, root), target, { recursive: true });
}
if (clean) await rm(new URL('packages/create/skills', root), { recursive: true, force: true });
