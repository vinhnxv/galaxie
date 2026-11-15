// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { canary } from './host.js';
import { scanBundle } from './request-scan.js';
import { readEnv } from './secrets.js';

export function inspectFeedback(value: unknown): void {
  const text = JSON.stringify(value);
  assert.ok(!text.includes(canary), 'Credential canary appeared in complete feedback response');
  assert.deepEqual(
    scanBundle([text], readEnv()),
    [],
    'Generated credential appeared in complete feedback response',
  );
}

export function writeFeedback(name: string, value: unknown): void {
  inspectFeedback(value);
  const formatted = execFileSync(
    fileURLToPath(new URL('../../../node_modules/.bin/biome', import.meta.url)),
    ['format', '--stdin-file-path', `results/${name}`],
    { input: `${JSON.stringify(value, null, 2)}\n`, encoding: 'utf8' },
  );
  writeFileSync(new URL(`../results/${name}`, import.meta.url), formatted);
}
