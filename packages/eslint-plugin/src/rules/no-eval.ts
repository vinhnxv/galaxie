// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { Rule } from 'eslint';
import { globalPath } from '../globals.js';

const timers = new Set(['setTimeout', 'setInterval', 'setImmediate']);

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'Flag eval-style execution and runtime-built imports in agent packages.' },
    schema: [],
    messages: {
      codeExecution: 'Do not execute code through {{name}}; use reviewed, bundled agent code.',
      dynamicImport: 'Import only string-literal module sources from reviewed, bundled code.',
    },
  },
  create(context) {
    const check = (node: Rule.Node): void => {
      const path = globalPath(context, node);
      const name = path?.length === 1 ? path[0] : undefined;
      if (name === 'eval' || name === 'Function')
        context.report({ node, messageId: 'codeExecution', data: { name } });
    };
    return {
      Identifier: check,
      MemberExpression: check,
      CallExpression(node) {
        const path = globalPath(context, node.callee);
        const name = path?.length === 1 ? path[0] : undefined;
        const argument = node.arguments[0];
        if (
          name !== undefined &&
          timers.has(name) &&
          (argument?.type === 'TemplateLiteral' ||
            (argument?.type === 'Literal' && typeof argument.value === 'string'))
        )
          context.report({ node, messageId: 'codeExecution', data: { name } });
      },
      ImportExpression(node) {
        if (node.source.type !== 'Literal' || typeof node.source.value !== 'string')
          context.report({ node, messageId: 'dynamicImport' });
      },
    };
  },
};

export default rule;
