// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import { INTERRUPT_TWICE_CASE_NAMES, interruptTwiceCases } from './cases/interrupt-twice.js';
import golden from './golden/interrupt-twice.json' with { type: 'json' };
import { diff } from './support/diff.js';
import { normalize } from './support/normalize.js';
import { runGalaxie } from './support/transcript.js';

test.each(INTERRUPT_TWICE_CASE_NAMES)('%s matches native with zero differences', async (name) => {
  expect(diff(golden, normalize(await runGalaxie(interruptTwiceCases[name])))).toEqual([]);
});
