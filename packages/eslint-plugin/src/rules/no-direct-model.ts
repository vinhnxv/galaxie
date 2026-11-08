// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { Rule } from 'eslint';
import { globalPath, staticPropertyName } from '../globals.js';

const sources = [
  '@langchain/openai',
  '@langchain/anthropic',
  '@langchain/google-genai',
  '@langchain/ollama',
  '@langchain/mistralai',
  '@langchain/groq',
  '@langchain/community',
  '@mlc-ai/web-llm',
  '@google/genai',
  'openai',
  '@anthropic-ai/sdk',
  '@galaxie-ai/models',
];

/** ADK exports that build a model outside the host router; the rest of `@google/adk` is allowed. */
const adkSource = '@google/adk';
const adkModels = new Set(['Gemini', 'ApigeeLlm', 'ChromeBuiltInLlm', 'LLMRegistry', 'RoutedLlm']);

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

function isAdk(source: unknown): boolean {
  return typeof source === 'string' && matches(source, adkSource);
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
      directAdkModel:
        'Call host.adk.llm(role) instead of {{name}} so routing, labels, consent and budgets apply.',
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
    const adkNamespaces = new Set<string>();
    const importedName = (node: { type: string; name?: string; value?: unknown }): unknown =>
      node.type === 'Identifier' ? node.name : node.value;
    const checkAdkName = (node: Rule.Node, name: unknown): void => {
      if (typeof name === 'string' && adkModels.has(name))
        context.report({ node, messageId: 'directAdkModel', data: { name } });
    };
    const checkAdkMember = (node: Rule.Node & { type: 'MemberExpression' }): void => {
      if (node.object.type !== 'Identifier' || !adkNamespaces.has(node.object.name)) return;
      const name = staticPropertyName(node);
      if (name !== undefined) checkAdkName(node, name);
    };
    return {
      ImportDeclaration(node) {
        checkSource(node, node.source.value);
        if (!isAdk(node.source.value)) return;
        for (const specifier of node.specifiers) {
          if (specifier.type === 'ImportSpecifier')
            checkAdkName(node, importedName(specifier.imported));
          else if (specifier.type === 'ImportNamespaceSpecifier')
            adkNamespaces.add(specifier.local.name);
        }
      },
      ExportNamedDeclaration(node) {
        checkSource(node, node.source?.value);
        if (isAdk(node.source?.value))
          for (const specifier of node.specifiers)
            checkAdkName(node, importedName(specifier.local));
      },
      ExportAllDeclaration(node) {
        checkSource(node, node.source.value);
      },
      ImportExpression(node) {
        if (node.source.type === 'Literal') checkSource(node, node.source.value);
      },
      Identifier: checkGlobal,
      MemberExpression(node) {
        checkGlobal(node);
        checkAdkMember(node);
      },
    };
  },
};

export default rule;
