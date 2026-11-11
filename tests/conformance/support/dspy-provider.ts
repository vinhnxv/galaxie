// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import fixtures from '../cases-dspy/provider-fixtures.json' with { type: 'json' };

export const providerScenarios: readonly string[] = fixtures.scenarios.filter(
  (name) => !fixtures.nativeOnly.includes(name),
);
