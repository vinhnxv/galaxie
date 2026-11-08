// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { Linter, Rule } from 'eslint';
import noDirectModel from './rules/no-direct-model.js';
import noDirectNetwork from './rules/no-direct-network.js';
import noDirectStorage from './rules/no-direct-storage.js';
import noDom from './rules/no-dom.js';
import noEval from './rules/no-eval.js';

const version = '0.0.0';

interface GalaxiePlugin {
  meta: { name: string; version: string };
  rules: Record<string, Rule.RuleModule>;
  configs: { recommended: Linter.Config };
}

const galaxie: GalaxiePlugin = {
  meta: { name: '@galaxie-ai/eslint-plugin', version },
  rules: {
    'no-direct-network': noDirectNetwork,
    'no-direct-storage': noDirectStorage,
    'no-dom': noDom,
    'no-eval': noEval,
    'no-direct-model': noDirectModel,
  },
  configs: { recommended: {} },
};

galaxie.configs.recommended = {
  plugins: { galaxie },
  rules: Object.fromEntries(Object.keys(galaxie.rules).map((name) => [`galaxie/${name}`, 'error'])),
};

export default galaxie;
