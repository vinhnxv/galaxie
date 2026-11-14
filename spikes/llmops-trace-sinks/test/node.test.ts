// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { scenarioReadback } from '../src/scenario-readback.js';
import { runScenario, scenarios } from '../src/scenarios.js';

if (process.env['LLMOPS_STACK'] !== '1')
  console.info('Node host live checks skipped; run pnpm run node-host.');

test.skipIf(process.env['LLMOPS_STACK'] !== '1').each(scenarios)(
  '%s reaches both backends with every oracle span',
  async (name) => {
    const variants = [];
    for (const text of [false, true])
      variants.push(await scenarioReadback(await runScenario(name, { text, live: true })));
    const folder = new URL('../results/', import.meta.url);
    mkdirSync(folder, { recursive: true });
    const filename = `results/node-${name}.json`;
    const formatted = execFileSync(
      fileURLToPath(new URL('../../../node_modules/.bin/biome', import.meta.url)),
      ['format', '--stdin-file-path', filename],
      {
        input: `${JSON.stringify({ demonstration: true, variants }, null, 2)}\n`,
        encoding: 'utf8',
      },
    );
    writeFileSync(new URL(`node-${name}.json`, folder), formatted);
  },
);
