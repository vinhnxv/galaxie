// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type {
  MaterializedSurface,
  ProtocolErrorCode,
  ProtocolFailure,
  TrustedBinding,
} from './envelope.js';
import { isObject, jsonBytes, pointerParts, resolveDataPath, setOwn } from './json.js';
import type {
  Component,
  JsonObject,
  JsonValue,
  RegisteredExtensions,
  SyncSchema,
} from './messages.js';
import { onlyKeys, schemaAccepts, validMetadata } from './messages.js';

export interface CatalogComponent {
  readonly props: SyncSchema;
  readonly child?: readonly string[];
  readonly children?: readonly string[];
  readonly urls?: readonly string[];
  readonly bindable?: readonly string[];
  readonly allowedParents?: readonly string[];
  readonly allowedChildren?: readonly string[];
}

export interface CatalogFunction {
  readonly allowedCallers: 'rendererOnly' | 'agentOnly' | 'rendererOrAgent';
  readonly requiresUserActivation?: boolean;
  readonly args: SyncSchema;
}

export interface Catalog {
  readonly id: string;
  readonly components: Readonly<Record<string, CatalogComponent>>;
  readonly functions?: Readonly<Record<string, CatalogFunction>>;
}

export interface ValidationOptions {
  readonly limits: { readonly payloadBytes: number; readonly components: number };
  readonly isAllowedUrl: (url: string) => boolean;
}

export interface SurfaceContext extends ValidationOptions {
  readonly binding: TrustedBinding;
  readonly catalog: Catalog;
  /** Extension schemas, never extension-provided authority. */
  readonly extensions?: RegisteredExtensions;
}

interface Edge {
  readonly target: string;
  readonly path?: string;
}
interface Entry {
  readonly component: Component;
  readonly definition: CatalogComponent;
  readonly props: JsonObject;
}
interface Instance {
  readonly id: string;
  readonly item?: JsonValue;
  readonly index?: number;
  readonly expanded: boolean;
  readonly scope: number;
}
interface FunctionUse {
  readonly call: JsonObject;
  readonly action: boolean;
  readonly template: boolean;
}

const COMMON = ['id', 'component', 'catalogId', 'accessibility', 'metadata'];
const failure = (code: ProtocolErrorCode): ProtocolFailure => ({ ok: false, code });

function containsBinding(value: JsonValue): boolean {
  if (Array.isArray(value)) return value.some(containsBinding);
  return (
    isObject(value) && (Object.hasOwn(value, '@path') || Object.values(value).some(containsBinding))
  );
}

function containsPropertyCall(value: JsonValue): boolean {
  if (Array.isArray(value)) return value.some(containsPropertyCall);
  if (!isObject(value) || Object.hasOwn(value, 'functionCall')) return false;
  return Object.hasOwn(value, '@call') || Object.values(value).some(containsPropertyCall);
}

function propertyShape(value: JsonValue, actionObjects = true): boolean {
  if (Array.isArray(value)) return value.every((item) => propertyShape(item, actionObjects));
  if (!isObject(value)) return true;
  if (Object.hasOwn(value, '@path')) {
    return onlyKeys(value, ['@path']) && typeof value['@path'] === 'string';
  }
  if (Object.hasOwn(value, '@call')) {
    return (
      onlyKeys(value, ['@call', 'args', 'catalogId']) &&
      (value['args'] === undefined || propertyShape(value['args'], false))
    );
  }
  if (Object.keys(value).some((key) => key.startsWith('@'))) return false;
  if (
    actionObjects &&
    Object.hasOwn(value, 'functionCall') &&
    (!onlyKeys(value, ['functionCall']) ||
      !isObject(value['functionCall']) ||
      !Object.hasOwn(value['functionCall'], '@call'))
  )
    return false;
  if (actionObjects && Object.hasOwn(value, 'event')) {
    const event = value['event'];
    if (
      !onlyKeys(value, ['event']) ||
      !isObject(event) ||
      !onlyKeys(event, ['name', 'userMessage', 'context']) ||
      typeof event['name'] !== 'string' ||
      event['name'].length === 0 ||
      (event['userMessage'] !== undefined && typeof event['userMessage'] !== 'string') ||
      (event['context'] !== undefined && !isObject(event['context']))
    )
      return false;
  }
  return Object.values(value).every((item) => propertyShape(item, actionObjects));
}

function accessibilityShape(value: JsonValue): boolean {
  if (!isObject(value) || !onlyKeys(value, ['label', 'description', 'live', 'hidden'])) {
    return false;
  }
  return (
    (value['hidden'] === undefined || typeof value['hidden'] === 'boolean') &&
    (value['live'] === undefined ||
      ['off', 'polite', 'assertive'].includes(String(value['live']))) &&
    ['label', 'description'].every(
      (key) =>
        value[key] === undefined ||
        typeof value[key] === 'string' ||
        (isObject(value[key]) &&
          (Object.hasOwn(value[key], '@path') || Object.hasOwn(value[key], '@call'))),
    )
  );
}

function reservedData(value: JsonValue): boolean {
  if (Array.isArray(value)) return value.some(reservedData);
  return (
    isObject(value) &&
    Object.entries(value).some(([key, item]) => key.startsWith('@') || reservedData(item))
  );
}

function dataAt(path: string, model: JsonObject, instance: Instance): JsonValue | undefined {
  return resolveDataPath(path, model, instance.index === undefined ? undefined : instance.item);
}

/** Whole-candidate checks; the reducer owns parsing, wire-order operations and revisions. */
export function validateCandidate(
  surface: MaterializedSurface,
  context: SurfaceContext,
  duplicates = false,
): ProtocolFailure | undefined {
  const { catalog, limits } = context;
  const components = Object.values(surface.components);
  if (components.length > limits.components) return failure('TOO_MANY_COMPONENTS');
  if (jsonBytes(surface) > limits.payloadBytes) return failure('PAYLOAD_TOO_LARGE');
  if (surface.status === 'deleted') {
    if (duplicates) return failure('DUPLICATE_COMPONENT_ID');
    return components.length === 0 && Object.keys(surface.dataModel).length === 0
      ? undefined
      : failure('INTEGRITY_ERROR');
  }

  const entries = new Map<string, Entry>();
  const edges = new Map<string, Edge[]>();
  for (const definition of Object.values(catalog.components)) {
    if (definition.urls?.some((key) => definition.bindable?.includes(key))) {
      return failure('INVALID_COMPONENT_PROPERTY');
    }
  }
  for (const component of components) {
    if (
      !Object.hasOwn(catalog.components, component.component) ||
      component.component === 'Surface'
    )
      return failure('UNKNOWN_COMPONENT');
    const definition = catalog.components[component.component] as CatalogComponent;
    if (
      component['metadata'] !== undefined &&
      !validMetadata(component['metadata'], context.extensions ?? {})
    )
      return failure('UNKNOWN_FIELD');
    if (component['accessibility'] !== undefined && !accessibilityShape(component['accessibility']))
      return failure('INVALID_COMPONENT_PROPERTY');
    const props = Object.fromEntries(
      Object.entries(component).filter(([key]) => !COMMON.includes(key)),
    );
    for (const [key, value] of Object.entries(props)) {
      if (
        definition.urls?.includes(key) &&
        (containsBinding(value) || containsPropertyCall(value))
      ) {
        return failure('URL_BINDING_FORBIDDEN');
      }
      if (containsBinding(value) && !definition.bindable?.includes(key)) {
        return failure('INVALID_COMPONENT_PROPERTY');
      }
      if (containsPropertyCall(value) && !definition.bindable?.includes(key)) {
        return failure('INVALID_COMPONENT_PROPERTY');
      }
    }
    if (
      !propertyShape(props) ||
      (component['accessibility'] !== undefined && !propertyShape(component['accessibility']))
    )
      return failure('INVALID_COMPONENT_PROPERTY');
    if (!containsBinding(props) && !schemaAccepts(definition.props, props)) {
      return failure('INVALID_COMPONENT_PROPERTY');
    }
    const references: Edge[] = [];
    for (const key of definition.child ?? []) {
      const value = props[key];
      if (value === undefined) continue;
      if (typeof value !== 'string') return failure('INVALID_COMPONENT_PROPERTY');
      references.push({ target: value });
    }
    for (const key of definition.children ?? []) {
      const value = props[key];
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        if (value.some((id) => typeof id !== 'string')) {
          return failure('INVALID_COMPONENT_PROPERTY');
        }
        if (new Set(value).size !== value.length) duplicates = true;
        for (const target of value) references.push({ target: target as string });
      } else if (
        isObject(value) &&
        onlyKeys(value, ['componentId', 'path']) &&
        typeof value['componentId'] === 'string' &&
        typeof value['path'] === 'string'
      ) {
        references.push({ target: value['componentId'], path: value['path'] });
      } else return failure('INVALID_COMPONENT_PROPERTY');
    }
    entries.set(component.id, { component, definition, props });
    edges.set(component.id, references);
  }
  if (!entries.has('root')) return failure('MISSING_ROOT');
  if (duplicates) return failure('DUPLICATE_COMPONENT_ID');
  const incoming = new Set<string>();
  for (const references of edges.values()) {
    for (const edge of references) {
      if (!entries.has(edge.target)) return failure('UNRESOLVED_REFERENCE');
      incoming.add(edge.target);
    }
  }
  const colors = new Map<string, number>();
  for (const id of entries.keys()) {
    const stack: { id: string; exit: boolean }[] = [{ id, exit: false }];
    while (stack.length > 0) {
      const frame = stack.pop();
      if (frame === undefined) break;
      if (frame.exit) {
        colors.set(frame.id, 2);
        continue;
      }
      if (colors.get(frame.id) === 1) return failure('CYCLIC_COMPONENTS');
      if (colors.get(frame.id) === 2) continue;
      colors.set(frame.id, 1);
      stack.push({ id: frame.id, exit: true });
      for (const edge of edges.get(frame.id) ?? []) stack.push({ id: edge.target, exit: false });
    }
  }
  const root = entries.get('root') as Entry;
  if (
    root.definition.allowedParents !== undefined &&
    !root.definition.allowedParents.includes('Surface')
  )
    return failure('UNALLOWED_PARENT');
  for (const [id, references] of edges) {
    for (const edge of references) {
      const parent = entries.get(id) as Entry;
      const child = entries.get(edge.target) as Entry;
      if (
        child.definition.allowedParents !== undefined &&
        !child.definition.allowedParents.includes(parent.component.component)
      )
        return failure('UNALLOWED_PARENT');
      if (
        parent.definition.allowedChildren !== undefined &&
        !parent.definition.allowedChildren.includes(child.component.component)
      )
        return failure('UNALLOWED_CHILD');
    }
  }
  if (reservedData(surface.dataModel)) return failure('RESERVED_DATA_KEY');

  // Validate pointer syntax before expansion. Template resolution and length are checked before
  // inspecting its items; a huge list cannot cause unbounded instance traversal.
  const pathSyntax = (value: JsonValue): boolean => {
    if (Array.isArray(value)) return value.every(pathSyntax);
    if (!isObject(value)) return true;
    if (
      Object.hasOwn(value, '@path') &&
      (typeof value['@path'] !== 'string' || pointerParts(value['@path'], true) === undefined)
    )
      return false;
    return Object.values(value).every(pathSyntax);
  };
  for (const entry of entries.values()) {
    if (
      !pathSyntax(entry.props) ||
      (entry.component['accessibility'] !== undefined &&
        !pathSyntax(entry.component['accessibility']))
    )
      return failure('INVALID_DATA_PATH');
  }
  const instances: Instance[] = [];
  const pending: Instance[] = [...entries.keys()]
    .filter((id) => !incoming.has(id))
    .map((id) => ({
      id,
      expanded: false,
      scope: 0,
    }));
  let expanded = components.length;
  let scope = 0;
  const seen = new Set<string>();
  while (pending.length > 0) {
    const instance = pending.pop();
    if (instance === undefined) break;
    const key = JSON.stringify([instance.id, instance.scope]);
    if (seen.has(key)) continue;
    seen.add(key);
    if (instance.expanded && ++expanded > limits.components) return failure('TOO_MANY_COMPONENTS');
    instances.push(instance);
    for (const edge of edges.get(instance.id) ?? []) {
      if (edge.path === undefined) {
        pending.push({ ...instance, id: edge.target });
      } else {
        const values = dataAt(edge.path, surface.dataModel, instance);
        if (!Array.isArray(values)) return failure('INVALID_DATA_PATH');
        if (values.length > limits.components - expanded) return failure('TOO_MANY_COMPONENTS');
        for (let index = 0; index < values.length; index++) {
          pending.push({
            id: edge.target,
            item: values[index] as JsonValue,
            index,
            expanded: true,
            scope: ++scope,
          });
        }
      }
    }
  }
  // Empty templates still have a declaration: check call sites and pointer syntax even without items.
  const visited = new Set(instances.map((instance) => instance.id));
  for (const id of entries.keys()) {
    if (!visited.has(id)) instances.push({ id, index: -1, expanded: false, scope: -1 });
  }
  const functions: FunctionUse[] = [];
  let propertyError: ProtocolErrorCode | undefined;
  const resolve = (
    value: JsonValue,
    instance: Instance,
    action = false,
    actionObjects = true,
  ): JsonValue => {
    if (Array.isArray(value)) {
      return value.map((item) => resolve(item, instance, action, actionObjects));
    }
    if (!isObject(value)) return value;
    if (Object.hasOwn(value, '@path')) {
      const path = value['@path'] as string;
      if (instance.index === -1 && path !== '' && !path.startsWith('/')) return value;
      const resolved = dataAt(path, surface.dataModel, instance);
      if (resolved === undefined) propertyError = 'INVALID_DATA_PATH';
      return resolved ?? null;
    }
    if (Object.hasOwn(value, '@call')) {
      const call = {
        ...value,
        ...(value['args'] === undefined
          ? {}
          : { args: resolve(value['args'], instance, false, false) }),
      };
      functions.push({ call, action, template: instance.index !== undefined });
      return call;
    }
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      setOwn(
        result,
        key,
        resolve(item, instance, (actionObjects && key === 'functionCall') || action, actionObjects),
      );
    }
    return result;
  };
  for (const instance of instances) {
    const entry = entries.get(instance.id) as Entry;
    propertyError = undefined;
    const props = resolve(entry.props, instance);
    const accessibility = entry.component['accessibility'];
    const resolvedAccessibility =
      accessibility === undefined ? undefined : resolve(accessibility, instance);
    if (propertyError !== undefined) return failure(propertyError);
    if (
      (containsBinding(entry.props) && !schemaAccepts(entry.definition.props, props)) ||
      (resolvedAccessibility !== undefined &&
        (!accessibilityShape(resolvedAccessibility) ||
          (isObject(resolvedAccessibility) &&
            ['label', 'description'].some(
              (key) =>
                resolvedAccessibility[key] !== undefined &&
                typeof resolvedAccessibility[key] !== 'string' &&
                !isObject(resolvedAccessibility[key]),
            ))))
    )
      return failure('INVALID_COMPONENT_PROPERTY');
  }
  for (const definition of Object.values(catalog.functions ?? {})) {
    if (definition.requiresUserActivation && definition.allowedCallers !== 'rendererOnly') {
      return failure('USER_ACTIVATION_REQUIRED');
    }
  }
  for (const { call, action, template } of functions) {
    const name = call['@call'];
    const args = call['args'] === undefined ? {} : call['args'];
    if (name === 'callAgentFunction') return failure('UNSUPPORTED_AGENT_FUNCTION');
    if (call['catalogId'] !== undefined && call['catalogId'] !== context.binding.catalogId) {
      return failure('BINDING_MISMATCH');
    }
    if (name === '@index' && template) {
      if (!isObject(args) || Object.keys(args).length !== 0) {
        return failure('INVALID_FUNCTION_ARGUMENTS');
      }
      continue;
    }
    const definition =
      typeof name === 'string' && Object.hasOwn(catalog.functions ?? {}, name)
        ? catalog.functions?.[name]
        : undefined;
    if (definition === undefined || name === '@index') return failure('UNKNOWN_FUNCTION');
    if (definition.allowedCallers === 'agentOnly') return failure('FUNCTION_CALLER_DENIED');
    if (definition.requiresUserActivation && !action) return failure('USER_ACTIVATION_REQUIRED');
    if (!isObject(args) || !schemaAccepts(definition.args, args)) {
      return failure('INVALID_FUNCTION_ARGUMENTS');
    }
  }
  for (const { definition, props } of entries.values()) {
    for (const key of definition.urls ?? []) {
      const url = props[key];
      if (url === undefined) continue;
      try {
        if (typeof url !== 'string' || /[\t\n\v\f\r ]/.test(url) || !context.isAllowedUrl(url))
          return failure('URL_NOT_ALLOWED');
      } catch {
        return failure('URL_NOT_ALLOWED');
      }
    }
  }
  return undefined;
}
