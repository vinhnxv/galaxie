// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { test } from 'vitest';
import { runFinancial } from './support/financial.js';
import { assertFinancialScenario, assertFinancialState } from './support/financial-assertions.js';

test('four specialists persist the upstream output keys and pass their findings downstream', async () => {
  const result = await runFinancial();
  assertFinancialState(result);
});

test.each(['normal', 'empty', 'blocked', 'budget', 'injection'] as const)(
  'financial recipe checks streaming and the %s scenario through the real runtime',
  async (scenario) => assertFinancialScenario(scenario, await runFinancial(scenario)),
);
