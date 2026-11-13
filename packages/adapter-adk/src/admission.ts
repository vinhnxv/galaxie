// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { LlmAgent, LoopAgent, ParallelAgent, SequentialAgent } from '@google/adk';
import { failure } from './errors.js';
import type { AdkHost } from './host.js';

const ALLOWED: ReadonlySet<object> = new Set([
  LlmAgent.prototype,
  SequentialAgent.prototype,
  ParallelAgent.prototype,
  LoopAgent.prototype,
]);
const MAX_DEPTH = 16;
const MAX_AGENTS = 256;

interface Snapshot {
  readonly prototype: object;
  readonly fields: Map<PropertyKey, PropertyDescriptor>;
  readonly children: readonly Snapshot[];
}

/** Indexed data reads avoid array iterators, accessors, constructors and species. */
function arrayCopy(value: unknown[]): unknown[] {
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value as number;
  const copy: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor)) throw failure('unsupported');
    copy.push(descriptor.value);
  }
  return copy;
}

function fieldsOf(value: object): Map<PropertyKey, PropertyDescriptor> {
  const fields = new Map<PropertyKey, PropertyDescriptor>();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) throw failure('unsupported');
    fields.set(key, {
      value: Array.isArray(descriptor.value) ? arrayCopy(descriptor.value) : descriptor.value,
      enumerable: descriptor.enumerable === true,
      configurable: true,
      writable: true,
    });
  }
  return fields;
}

function materialize(prototype: object, fields: Map<PropertyKey, PropertyDescriptor>): object {
  const copy = Object.create(prototype) as object;
  for (const [key, descriptor] of fields) Object.defineProperty(copy, key, descriptor);
  return copy;
}

/** Resolve opted-in roles in an isolated tree; author objects are exclusively read. */
export function admitRoleStrings(root: unknown, host: AdkHost, roles: readonly string[]): unknown {
  const seen = new Set<object>();
  const path = new Set<object>();
  let strings = false;
  const snapshot = (agent: unknown, depth: number): Snapshot => {
    if (typeof agent !== 'object' || agent === null) throw failure('invalid');
    if (depth > MAX_DEPTH || seen.size >= MAX_AGENTS || path.has(agent)) throw failure('invalid');
    // A subclass or foreign object must be refused before any property read.
    const prototype: object = Object.getPrototypeOf(agent) as object;
    if (!ALLOWED.has(prototype)) throw failure('unsupported');
    if (seen.has(agent)) throw failure('unsupported');
    seen.add(agent);
    path.add(agent);
    const fields = fieldsOf(agent);
    if (depth === 0 && fields.get('parentAgent')?.value !== undefined) throw failure('unsupported');
    if (prototype === LlmAgent.prototype && typeof fields.get('model')?.value === 'string')
      strings = true;
    const children: unknown = fields.get('subAgents')?.value;
    if (!Array.isArray(children)) throw failure('invalid');
    const snapshots = children.map((child: unknown) => snapshot(child, depth + 1));
    path.delete(agent);
    return { prototype, fields, children: snapshots };
  };
  const tree = snapshot(root, 0);
  if (!strings) return root;
  const declared = new Set(roles);
  if (declared.size !== roles.length) throw failure('unsupported');
  const build = (node: Snapshot, parent: object | undefined): object => {
    const fields = node.fields;
    const model: unknown = fields.get('model')?.value;
    if (node.prototype === LlmAgent.prototype && typeof model === 'string') {
      if (model.length === 0 || !declared.has(model)) throw failure('unsupported');
      const descriptor = fields.get('model');
      if (descriptor !== undefined) descriptor.value = host.adk.llm(model);
    }
    const copy = materialize(node.prototype, fields);
    const children = node.children.map((child) => build(child, copy));
    Object.defineProperty(copy, 'parentAgent', { ...fields.get('parentAgent'), value: parent });
    Object.defineProperty(copy, 'subAgents', { ...fields.get('subAgents'), value: children });
    const config: unknown = fields.get('config')?.value;
    if (typeof config !== 'object' || config === null) throw failure('unsupported');
    const configFields = fieldsOf(config);
    configFields.set('model', {
      value: fields.get('model')?.value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    configFields.set('subAgents', {
      value: children,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    configFields.set('parentAgent', {
      value: parent,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(copy, 'config', {
      ...fields.get('config'),
      value: materialize(Object.prototype, configFields),
    });
    return copy;
  };
  return build(tree, undefined);
}
