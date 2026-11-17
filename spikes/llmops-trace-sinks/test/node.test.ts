// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'vitest';
import { resultJson } from '../src/result-json.js';
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
    writeFileSync(
      new URL(`node-${name}.json`, folder),
      resultJson({ demonstration: true, variants }),
    );
  },
);
