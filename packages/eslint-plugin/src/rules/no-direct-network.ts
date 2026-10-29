// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { Rule } from 'eslint';
import { globalPath, networkName } from '../globals.js';

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'Flag direct network access in agent packages.' },
    schema: [],
    messages: { directNetwork: 'Use a host-bound capability instead of {{name}}.' },
  },
  create(context) {
    const check = (node: Rule.Node): void => {
      const name = networkName(globalPath(context, node));
      if (name !== undefined) context.report({ node, messageId: 'directNetwork', data: { name } });
    };
    return { Identifier: check, MemberExpression: check };
  },
};

export default rule;
