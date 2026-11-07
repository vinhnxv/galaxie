// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  DEFAULT_BUDGETS,
  type ErrorInfo,
  type PendingInteraction,
  surfaceFromRequest,
  toErrorInfo,
} from '@galaxie/core';
import {
  type CatalogComponent,
  type Component,
  type JsonObject,
  type JsonValue,
  type MaterializedSurface,
  resolveDataPath,
} from '@galaxie/ui-protocol';
import type { ComponentEntry, Registry } from '../registry.js';
import { hasBinding, object, resolveBindings } from './bindings.js';
import { catalogComponentId, catalogLocation } from './catalog.js';

export interface AccessibilityAttributes {
  readonly label?: string;
  readonly description?: string;
  readonly live?: 'off' | 'polite' | 'assertive';
  readonly hidden?: boolean;
}

export interface PreparedComponent {
  readonly id: string;
  readonly key: string;
  readonly entry: ComponentEntry;
  readonly props: unknown;
  readonly children?: readonly PreparedComponent[];
  readonly accessibility?: AccessibilityAttributes;
}

export type PreparedSurface =
  | { readonly ok: true; readonly root: PreparedComponent }
  | { readonly ok: false; readonly error: ErrorInfo };

interface Declaration {
  readonly component: Component;
  readonly definition: CatalogComponent;
  readonly props: JsonObject;
  readonly edges: readonly {
    readonly target: string;
    readonly key: string;
    readonly path?: string;
  }[];
}

function accessibility(value: JsonValue | undefined): AccessibilityAttributes | undefined {
  if (value === undefined) return undefined;
  if (
    !object(value) ||
    Object.keys(value).some((key) => !['label', 'description', 'live', 'hidden'].includes(key)) ||
    (value['label'] !== undefined && typeof value['label'] !== 'string') ||
    (value['description'] !== undefined && typeof value['description'] !== 'string') ||
    (value['hidden'] !== undefined && typeof value['hidden'] !== 'boolean') ||
    (value['live'] !== undefined && !['off', 'polite', 'assertive'].includes(String(value['live'])))
  )
    throw new Error();
  const live = value['live'];
  return {
    ...(typeof value['label'] === 'string' ? { label: value['label'] } : {}),
    ...(typeof value['description'] === 'string' ? { description: value['description'] } : {}),
    ...(typeof value['hidden'] === 'boolean' ? { hidden: value['hidden'] } : {}),
    ...(live === 'off' || live === 'polite' || live === 'assertive' ? { live } : {}),
  };
}

/** Resolve the entire tree before mounting any host component. Core remains the publication gate. */
export function prepareSurface(pending: PendingInteraction, registry: Registry): PreparedSurface {
  const fail = (code: 'invalid' | 'unsupported' | 'denied'): PreparedSurface => ({
    ok: false,
    error: toErrorInfo(code),
  });
  const componentLimit = DEFAULT_BUDGETS.uiElements;
  try {
    let surface: MaterializedSurface | undefined = pending.surface;
    if (surface === undefined) {
      const { catalogId } = catalogLocation(pending.component);
      surface = surfaceFromRequest(
        {
          surfaceId: pending.surfaceId,
          viewRevision: pending.viewRevision,
          component: pending.component,
          props: pending.props as Readonly<Record<string, unknown>>,
        },
        catalogId,
      );
      if (surface === undefined) {
        const resolved = registry.resolve(pending);
        if (!resolved.ok) return resolved;
        // Reserved legacy prop names retain the registry's existing resolution behavior.
        return {
          ok: true,
          root: { id: 'root', key: 'root', entry: resolved.entry, props: resolved.props },
        };
      }
    }
    const model = surface;
    const catalog = registry.catalogs()[surface.catalogId];
    if (catalog === undefined) return fail('unsupported');
    const declarations = new Map<string, Declaration>();
    if (Object.keys(surface.components).length > componentLimit) return fail('denied');
    const incoming = new Set<string>();
    const hasCall = (value: JsonValue): boolean =>
      Array.isArray(value)
        ? value.some(hasCall)
        : object(value) &&
          (Object.hasOwn(value, '@call') ||
            Object.hasOwn(value, 'functionCall') ||
            Object.values(value).some(hasCall));
    for (const [id, component] of Object.entries(surface.components)) {
      if (id !== component.id) return fail('invalid');
      if (!Object.hasOwn(catalog.components, component.component)) return fail('unsupported');
      if (component.component === 'Surface') return fail('unsupported');
      const definition = catalog.components[component.component] as CatalogComponent;
      if (pending.surface !== undefined && hasCall(component)) return fail('unsupported');
      const props =
        pending.surface === undefined
          ? (pending.props as JsonObject)
          : Object.fromEntries(
              Object.entries(component).filter(
                ([key]) =>
                  !['id', 'component', 'catalogId', 'accessibility', 'metadata'].includes(key),
              ),
            );
      for (const [key, value] of Object.entries(props)) {
        if (pending.surface !== undefined && hasBinding(value) && definition.urls?.includes(key))
          return fail('denied');
        if (
          pending.surface !== undefined &&
          hasBinding(value) &&
          !definition.bindable?.includes(key)
        )
          return fail('invalid');
      }
      const edges: Array<{ target: string; key: string; path?: string }> = [];
      for (const key of definition.child ?? []) {
        const target = props[key];
        if (target === undefined) continue;
        if (typeof target !== 'string') return fail('invalid');
        edges.push({ target, key: JSON.stringify([key, target]) });
      }
      for (const key of definition.children ?? []) {
        const list = props[key];
        if (list === undefined) continue;
        if (Array.isArray(list)) {
          if (new Set(list).size !== list.length) return fail('invalid');
          for (const target of list) {
            if (typeof target !== 'string') return fail('invalid');
            edges.push({ target, key: JSON.stringify([key, target]) });
          }
        } else if (
          object(list) &&
          Object.keys(list).every((key) => ['componentId', 'path'].includes(key)) &&
          typeof list['componentId'] === 'string' &&
          typeof list['path'] === 'string'
        ) {
          edges.push({ target: list['componentId'], key, path: list['path'] });
        } else return fail('invalid');
      }
      declarations.set(id, { component, definition, props, edges });
      for (const edge of edges) incoming.add(edge.target);
    }
    if (!declarations.has('root')) return fail('invalid');
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const check = (id: string): void => {
      if (visiting.has(id)) throw new Error();
      if (visited.has(id)) return;
      const node = declarations.get(id);
      if (node === undefined) throw new Error();
      visiting.add(id);
      for (const edge of node.edges) {
        const child = declarations.get(edge.target);
        if (
          child === undefined ||
          (node.definition.allowedChildren !== undefined &&
            !node.definition.allowedChildren.includes(child.component.component)) ||
          (child.definition.allowedParents !== undefined &&
            !child.definition.allowedParents.includes(node.component.component))
        )
          throw new Error();
        check(edge.target);
      }
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of declarations.keys()) check(id);
    const rootDefinition = declarations.get('root')?.definition;
    if (
      rootDefinition?.allowedParents !== undefined &&
      !rootDefinition.allowedParents.includes('Surface')
    )
      return fail('invalid');
    let expanded = declarations.size;
    let rendered = 0;
    let overLimit = false;
    const instantiated = new Set<string>();
    const build = (
      id: string,
      key: string,
      item?: JsonValue,
      template = false,
    ): PreparedComponent => {
      if (++rendered > componentLimit || (template && ++expanded > componentLimit)) {
        overLimit = true;
        throw new Error();
      }
      const node = declarations.get(id) as Declaration;
      instantiated.add(id);
      const props =
        pending.surface === undefined
          ? node.props
          : resolveBindings(node.props, model.dataModel, item);
      const resolved = registry.resolve({
        ...pending,
        component: catalogComponentId(model.catalogId, node.component.component),
        props,
      });
      if (!resolved.ok) throw resolved.error;
      const children: PreparedComponent[] = [];
      for (const edge of node.edges) {
        if (edge.path === undefined) children.push(build(edge.target, edge.key, item, template));
        else {
          const values = resolveDataPath(edge.path, model.dataModel, item);
          if (!Array.isArray(values)) throw new Error();
          if (values.length > componentLimit - expanded) {
            overLimit = true;
            throw new Error();
          }
          for (let index = 0; index < values.length; index++)
            children.push(
              build(
                edge.target,
                JSON.stringify([edge.key, edge.target, index]),
                values[index],
                true,
              ),
            );
        }
      }
      const attributes = accessibility(
        pending.surface === undefined || node.component['accessibility'] === undefined
          ? undefined
          : resolveBindings(node.component['accessibility'], model.dataModel, item),
      );
      return {
        id,
        key,
        entry: resolved.entry,
        props: resolved.props,
        ...((node.definition.child?.length ?? 0) + (node.definition.children?.length ?? 0) === 0
          ? {}
          : { children }),
        ...(attributes === undefined ? {} : { accessibility: attributes }),
      };
    };
    try {
      const root = build('root', 'root');
      // Disconnected declarations are also untrusted, even though only root reaches the DOM.
      for (const id of declarations.keys())
        if (!instantiated.has(id) && !incoming.has(id)) build(id, id);
      for (const [id, node] of declarations) {
        if (instantiated.has(id)) continue;
        const resolved = registry.resolve({
          ...pending,
          component: catalogComponentId(model.catalogId, node.component.component),
          props: resolveBindings(node.props, model.dataModel, undefined, true),
        });
        if (!resolved.ok) return resolved;
        accessibility(
          node.component['accessibility'] === undefined
            ? undefined
            : resolveBindings(node.component['accessibility'], model.dataModel, undefined, true),
        );
      }
      return { ok: true, root };
    } catch (error) {
      if (overLimit) return fail('denied');
      if (object(error) && ['invalid', 'unsupported', 'denied'].includes(String(error['code'])))
        return fail(error['code'] as 'invalid' | 'unsupported' | 'denied');
      return fail('invalid');
    }
  } catch {
    return fail('invalid');
  }
}
