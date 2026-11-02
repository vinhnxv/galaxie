// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'vitest';
import { adkCases, runAdkNative } from './support/adk.js';

test.each(adkCases)('native ADK matches its golden: %s', async (name) => {
  const transcript = await runAdkNative(name);
  await expect(`${JSON.stringify(transcript, null, 2)}\n`).toMatchFileSnapshot(
    `./golden-adk/${name}.json`,
  );
});
