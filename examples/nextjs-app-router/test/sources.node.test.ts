// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { appRoot, repoRoot } from './support.js';

const copies = [
  'langgraph-js/agent.ts',
  'langgraph-js/executor.ts',
  'adk-js/agent.ts',
  'adk-js/executor.ts',
  'adk-js/adk-env.ts',
];

test.each(copies)('%s stays byte-identical to its framework template', async (copy) => {
  const [framework, file] = copy.split('/');
  expect(await readFile(join(appRoot, 'src', copy))).toEqual(
    await readFile(
      join(repoRoot, 'templates/frameworks', framework ?? '', 'files/src', file ?? ''),
    ),
  );
});
