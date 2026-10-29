// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { Rule } from 'eslint';
import {
  globalPath,
  isDynamicGlobal,
  networkName,
  staticPropertyName,
  storageName,
} from '../globals.js';

const domGlobals = new Set(['document', 'window', 'DOMParser', 'HTMLElement', 'navigator']);
const htmlAssignments = new Set(['innerHTML', 'outerHTML', 'srcdoc']);
const htmlCalls = new Set(['insertAdjacentHTML', 'createContextualFragment']);

function htmlSinkName(context: Rule.RuleContext, node: Rule.Node): string | undefined {
  if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression') {
    const name = staticPropertyName(node.left);
    if (name !== undefined && htmlAssignments.has(name)) return name;
  }
  if (node.type !== 'CallExpression') return undefined;
  const callee = node.callee;
  if (callee.type !== 'MemberExpression') return undefined;
  const name = staticPropertyName(callee);
  if (name !== undefined && htmlCalls.has(name)) return name;
  if (
    (name === 'write' || name === 'writeln') &&
    globalPath(context, callee.object)?.join('.') === 'document'
  )
    return name;
  return undefined;
}

function coveredAccess(context: Rule.RuleContext, node: Rule.Node): boolean {
  let outer = node;
  while (
    (outer.parent?.type === 'MemberExpression' && outer.parent.object === outer) ||
    outer.parent?.type === 'ChainExpression'
  ) {
    outer = outer.parent;
    const path = globalPath(context, outer);
    if (
      networkName(path) !== undefined ||
      storageName(path) !== undefined ||
      (outer.type === 'MemberExpression' && isDynamicGlobal(context, outer)) ||
      (path?.length === 1 && domGlobals.has(path[0] ?? ''))
    )
      return true;
  }
  return outer.parent !== null && htmlSinkName(context, outer.parent) !== undefined;
}

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'Keep DOM access and HTML rendering in the host catalog.' },
    schema: [],
    messages: {
      domAccess: 'The host renders UI through the catalog; do not access {{name}} directly.',
      htmlSink: 'Model output must render as text; do not use {{name}}.',
      dynamicGlobal:
        'Do not access a global with a dynamic key; use host-bound APIs and the UI catalog.',
    },
  },
  create(context) {
    const checkReference = (node: Rule.Node): void => {
      const path = globalPath(context, node);
      const name = path?.length === 1 ? path[0] : undefined;
      if (name !== undefined && domGlobals.has(name) && !coveredAccess(context, node))
        context.report({ node, messageId: 'domAccess', data: { name } });
    };
    const checkSink = (node: Rule.Node): void => {
      const name = htmlSinkName(context, node);
      if (name !== undefined) context.report({ node, messageId: 'htmlSink', data: { name } });
    };
    return {
      Identifier: checkReference,
      MemberExpression(node) {
        if (isDynamicGlobal(context, node)) context.report({ node, messageId: 'dynamicGlobal' });
        else checkReference(node);
      },
      AssignmentExpression: checkSink,
      CallExpression: checkSink,
      'JSXAttribute[name.name="dangerouslySetInnerHTML"]'(node: Rule.Node) {
        context.report({ node, messageId: 'htmlSink', data: { name: 'dangerouslySetInnerHTML' } });
      },
    };
  },
};

export default rule;
