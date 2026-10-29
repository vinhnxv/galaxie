// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { Rule, Scope } from 'eslint';

type Expression = Extract<Rule.Node, { type: 'ExpressionStatement' }>['expression'];
type Identifier = Extract<Expression, { type: 'Identifier' }>;
type Member = Extract<Expression, { type: 'MemberExpression' }>;

const globalObjects = new Set(['globalThis', 'window', 'self', 'global']);

export function isGlobalReference(context: Rule.RuleContext, node: Identifier): boolean {
  let scope: Scope.Scope | null = context.sourceCode.getScope(node);
  while (scope !== null) {
    const reference = scope.references.find((entry) => entry.identifier === node);
    if (reference?.resolved !== undefined && reference.resolved !== null)
      return reference.resolved.defs.length === 0;
    if (scope.upper === null) return scope.through.some((entry) => entry.identifier === node);
    scope = scope.upper;
  }
  return false;
}

export function staticPropertyName(node: Member): string | undefined {
  if (!node.computed && node.property.type === 'Identifier') return node.property.name;
  if (
    node.computed &&
    node.property.type === 'Literal' &&
    (typeof node.property.value === 'string' || typeof node.property.value === 'number')
  )
    return String(node.property.value);
  return undefined;
}

const networkGlobals = new Set([
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'WebTransport',
  'RTCPeerConnection',
  'importScripts',
]);
const storageGlobals = new Set([
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'caches',
  'cookieStore',
]);

export function networkName(path: readonly string[] | undefined): string | undefined {
  if (path?.length === 1 && networkGlobals.has(path[0] ?? '')) return path[0];
  if (path?.length === 2 && path[0] === 'navigator' && path[1] === 'sendBeacon')
    return 'navigator.sendBeacon';
  return undefined;
}

export function storageName(path: readonly string[] | undefined): string | undefined {
  if (path?.length === 1 && storageGlobals.has(path[0] ?? '')) return path[0];
  if (path?.length === 2 && path[0] === 'document' && path[1] === 'cookie')
    return 'document.cookie';
  if (path?.length === 2 && path[0] === 'navigator' && path[1] === 'storage')
    return 'navigator.storage';
  return undefined;
}

export function globalPath(
  context: Rule.RuleContext,
  node: Expression | Member['object'] | Rule.Node,
): readonly string[] | undefined {
  if (node.type === 'ChainExpression') return globalPath(context, node.expression);
  if (node.type === 'Identifier') return isGlobalReference(context, node) ? [node.name] : undefined;
  if (node.type !== 'MemberExpression') return undefined;
  const object = globalPath(context, node.object);
  const property = staticPropertyName(node);
  if (object === undefined || property === undefined) return undefined;
  return object.length === 1 && globalObjects.has(object[0] ?? '')
    ? [property]
    : [...object, property];
}

export function isDynamicGlobal(context: Rule.RuleContext, node: Member): boolean {
  if (!node.computed || node.property.type === 'Literal') return false;
  const object = globalPath(context, node.object);
  return object?.length === 1 && globalObjects.has(object[0] ?? '');
}
