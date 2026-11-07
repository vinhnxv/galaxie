// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { ComponentId } from '@galaxie/core';
import type { Catalog, CatalogComponent } from '@galaxie/ui-protocol';
import type { RegistryComponent } from '../registry.js';

/** Catalog-local names of properties and permitted parent/child components. */
export interface ComponentStructure {
  readonly child?: readonly string[];
  readonly children?: readonly string[];
  readonly bindable?: readonly string[];
  /** Literal URL property names, in addition to the entry's runtime URL extractor. */
  readonly urlProperties?: readonly string[];
  readonly allowedParents?: readonly string[];
  readonly allowedChildren?: readonly string[];
}

export function catalogLocation(id: ComponentId): { catalogId: string; name: string } {
  const dot = id.indexOf('.');
  const version = id.lastIndexOf('/v');
  return { catalogId: id.slice(0, dot) + id.slice(version), name: id.slice(dot + 1, version) };
}

export function catalogComponentId(catalogId: string, name: string): ComponentId {
  const version = catalogId.lastIndexOf('/v');
  return `${catalogId.slice(0, version)}.${name}${catalogId.slice(version)}` as ComponentId;
}

export function buildCatalogs(
  entries: readonly RegistryComponent[],
): Readonly<Record<string, Catalog>> {
  const groups = new Map<string, Array<readonly [string, CatalogComponent]>>();
  for (const entry of entries) {
    const { catalogId, name } = catalogLocation(entry.id);
    const components = groups.get(catalogId) ?? [];
    components.push([
      name,
      Object.freeze({
        // Registrations permit Standard Schema's async type; both consumers reject async results.
        props: entry.props as CatalogComponent['props'],
        ...(entry.child === undefined ? {} : { child: entry.child }),
        ...(entry.children === undefined ? {} : { children: entry.children }),
        ...(entry.bindable === undefined ? {} : { bindable: entry.bindable }),
        ...(entry.urlProperties === undefined ? {} : { urls: entry.urlProperties }),
        ...(entry.allowedParents === undefined ? {} : { allowedParents: entry.allowedParents }),
        ...(entry.allowedChildren === undefined ? {} : { allowedChildren: entry.allowedChildren }),
      }),
    ]);
    groups.set(catalogId, components);
  }
  return Object.freeze(
    Object.fromEntries(
      [...groups].map(([id, components]) => [
        id,
        Object.freeze({ id, components: Object.freeze(Object.fromEntries(components)) }),
      ]),
    ),
  );
}
