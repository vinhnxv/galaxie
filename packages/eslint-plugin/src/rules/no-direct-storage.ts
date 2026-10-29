// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { Rule } from 'eslint';
import { globalPath, storageName } from '../globals.js';

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'Flag direct storage access in agent packages.' },
    schema: [],
    messages: {
      directStorage: 'The host owns storage and checkpoints; do not access {{name}} directly.',
    },
  },
  create(context) {
    const check = (node: Rule.Node): void => {
      const name = storageName(globalPath(context, node));
      if (name !== undefined) context.report({ node, messageId: 'directStorage', data: { name } });
    };
    return { Identifier: check, MemberExpression: check };
  },
};

export default rule;
