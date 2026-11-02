// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { readFile, writeFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { adkCases, runAdkNative } from './support/adk.js';

// Goldens are committed Biome-formatted, so the lane compares parsed JSON. To rewrite them on
// purpose, run with ADK_UPDATE_GOLDEN=1 and then `pnpm format`; review the diff.
test.each(adkCases)('native ADK matches its golden: %s', async (name) => {
  const transcript = await runAdkNative(name);
  const path = new URL(`./golden-adk/${name}.json`, import.meta.url);
  if (process.env['ADK_UPDATE_GOLDEN'] === '1')
    await writeFile(path, `${JSON.stringify(transcript, null, 2)}\n`);
  else expect(transcript).toEqual(JSON.parse(await readFile(path, 'utf8')));
});
