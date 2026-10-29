// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { Linter, Rule } from 'eslint';

const version = '0.0.0';

interface GalaxiePlugin {
  meta: { name: string; version: string };
  rules: Record<string, Rule.RuleModule>;
  configs: { recommended: Linter.Config };
}

const galaxie: GalaxiePlugin = {
  meta: { name: '@galaxie/eslint-plugin', version },
  rules: {},
  configs: { recommended: {} },
};

galaxie.configs.recommended = {
  plugins: { galaxie },
  rules: Object.fromEntries(Object.keys(galaxie.rules).map((name) => [`galaxie/${name}`, 'error'])),
};

export default galaxie;
