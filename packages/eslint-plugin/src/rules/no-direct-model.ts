// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { Rule } from 'eslint';
import { globalPath } from '../globals.js';

const sources = [
  '@langchain/openai',
  '@langchain/anthropic',
  '@langchain/google-genai',
  '@langchain/ollama',
  '@langchain/mistralai',
  '@langchain/groq',
  '@langchain/community',
  '@mlc-ai/web-llm',
  'openai',
  '@anthropic-ai/sdk',
  '@galaxie/models',
];

const sourceList = {
  type: 'array',
  uniqueItems: true,
  items: {
    type: 'string',
    pattern:
      '^(?:@[a-zA-Z0-9_-]+/)?[a-zA-Z0-9_-][a-zA-Z0-9._-]*(?:/[a-zA-Z0-9_-][a-zA-Z0-9._-]*)*$',
  },
};

function matches(source: string, prefix: string): boolean {
  return source === prefix || source.startsWith(`${prefix}/`);
}

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'Route agent model calls through the host model router.' },
    schema: [
      {
        type: 'object',
        properties: { allow: sourceList, extraSources: sourceList },
        additionalProperties: false,
      },
    ],
    messages: {
      directModel:
        'Call host.langchain.chatModel(role) instead of {{name}} so routing, labels, consent and budgets apply.',
    },
  },
  create(context) {
    const options = context.options[0] as { allow?: string[]; extraSources?: string[] } | undefined;
    const blocked = [...sources, ...(options?.extraSources ?? [])];
    const checkSource = (node: Rule.Node, value: unknown): void => {
      if (typeof value !== 'string' || options?.allow?.some((prefix) => matches(value, prefix)))
        return;
      const name = blocked.find((prefix) => matches(value, prefix));
      if (name !== undefined) context.report({ node, messageId: 'directModel', data: { name } });
    };
    const checkGlobal = (node: Rule.Node): void => {
      if (globalPath(context, node)?.join('.') === 'LanguageModel')
        context.report({ node, messageId: 'directModel', data: { name: 'LanguageModel' } });
    };
    return {
      ImportDeclaration(node) {
        checkSource(node, node.source.value);
      },
      ExportNamedDeclaration(node) {
        checkSource(node, node.source?.value);
      },
      ExportAllDeclaration(node) {
        checkSource(node, node.source.value);
      },
      ImportExpression(node) {
        if (node.source.type === 'Literal') checkSource(node, node.source.value);
      },
      Identifier: checkGlobal,
      MemberExpression: checkGlobal,
    };
  },
};

export default rule;
