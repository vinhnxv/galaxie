// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  type ComponentId,
  type DispatchReceipt,
  type ErrorCode,
  type ErrorInfo,
  GalaxieError,
  isAllowedUrl,
  isComponentId,
  isStandardSchema,
  normalizeUrlAllowlist,
  type PendingInteraction,
  type StandardSchema,
  type SurfaceId,
  toErrorInfo,
  type UiBindings,
  validateSync,
} from '@galaxie-ai/core';
import type { Catalog } from '@galaxie-ai/ui-protocol';
import type { ReactElement, ReactNode } from 'react';
import { buildCatalogs, type ComponentStructure } from './a2ui/catalog.js';

export interface ActionDefinition<Payload = unknown, PayloadInput = Payload> {
  readonly label: string;
  readonly payload: StandardSchema<Payload, PayloadInput>;
}

export type ActionDefinitions = Readonly<Record<string, ActionDefinition>>;

export type SchemaOutput<S extends StandardSchema> =
  S extends StandardSchema<infer Output> ? Output : never;

/** The value a schema accepts; `submit` sends it unchanged so core can validate it again. */
export type SchemaInput<S extends StandardSchema> =
  NonNullable<S['~standard']['types']> extends { readonly input: infer Input }
    ? Input
    : SchemaOutput<S>;

export type BoundActions<Actions extends ActionDefinitions> = {
  readonly [Name in keyof Actions]: {
    readonly label: string;
    readonly submit: (payload: SchemaInput<Actions[Name]['payload']>) => Promise<DispatchReceipt>;
  };
};

export type InteractionStatus =
  | 'idle'
  | 'submitting'
  | 'accepted'
  | { readonly rejected: ErrorCode };

export interface ComponentProps<Props, Actions extends ActionDefinitions> {
  readonly props: Props;
  readonly actions: BoundActions<Actions>;
  readonly status: InteractionStatus;
  readonly children?: ReactNode;
}

export interface ComponentEntry<
  Props = unknown,
  Actions extends ActionDefinitions = ActionDefinitions,
  Id extends ComponentId = ComponentId,
> extends ComponentStructure {
  readonly id: Id;
  readonly props: StandardSchema<Props>;
  readonly actions: Actions;
  /** Every loaded or linked URL, each used verbatim as one attribute value. */
  readonly urls?: (props: Props) => readonly string[];
  readonly component: (input: ComponentProps<Props, Actions>) => ReactElement | null;
}

/** Collection shape; callbacks are callable only after the entry's own schema has validated. */
export interface RegistryComponent extends ComponentStructure {
  readonly id: ComponentId;
  readonly props: StandardSchema;
  readonly actions: ActionDefinitions;
  readonly urls?: (props: never) => readonly string[];
  readonly component: (input: never) => ReactElement | null;
}

export type ResolvedInteraction =
  | { readonly ok: true; readonly entry: ComponentEntry; readonly props: unknown }
  | { readonly ok: false; readonly error: ErrorInfo };

export interface Registry {
  catalogs(): Readonly<Record<string, Catalog>>;
  resolve(pending: PendingInteraction): ResolvedInteraction;
  bindings(options: { readonly surfaces: readonly SurfaceId[] }): UiBindings;
}

/** Retains schema output, action payload and component-ID inference for a trusted component. */
export function defineComponent<
  Props,
  const Actions extends ActionDefinitions,
  const Id extends ComponentId,
>(entry: ComponentEntry<Props, Actions, Id>): ComponentEntry<Props, Actions, Id> {
  return entry;
}

/** Builds a registry from reviewed host components; model data can only select and fill them. */
export function createRegistry(options: {
  readonly components: readonly RegistryComponent[];
  readonly urlAllowlist?: readonly string[];
}): Registry {
  const invalid = (): never => {
    throw new GalaxieError('invalid', 'The UI registry is invalid.');
  };
  const entries = new Map<ComponentId, ComponentEntry>();
  let allowlist: readonly string[];
  try {
    allowlist = normalizeUrlAllowlist(options.urlAllowlist);
    for (const entry of options.components) {
      if (
        !isComponentId(entry.id) ||
        entries.has(entry.id) ||
        !isStandardSchema(entry.props) ||
        typeof entry.component !== 'function' ||
        (entry.urls !== undefined && typeof entry.urls !== 'function') ||
        entry.actions === null ||
        typeof entry.actions !== 'object' ||
        Array.isArray(entry.actions)
      )
        invalid();
      const actions = Object.fromEntries(
        Object.entries(entry.actions).map(([name, action]) => {
          if (
            name.length === 0 ||
            action === null ||
            typeof action !== 'object' ||
            typeof action.label !== 'string' ||
            action.label.length === 0 ||
            !isStandardSchema(action.payload)
          )
            invalid();
          return [name, Object.freeze({ label: action.label, payload: action.payload })];
        }),
      );
      const stored = Object.freeze({
        id: entry.id,
        props: entry.props,
        actions: Object.freeze(actions),
        component: entry.component,
        ...(entry.urls === undefined ? {} : { urls: entry.urls }),
        ...Object.fromEntries(
          [
            'child',
            'children',
            'bindable',
            'urlProperties',
            'allowedParents',
            'allowedChildren',
          ].flatMap((key) => {
            const value = entry[key as keyof ComponentStructure];
            if (value === undefined) return [];
            if (!Array.isArray(value) || value.some((name) => typeof name !== 'string')) invalid();
            return [[key, Object.freeze([...value])]];
          }),
        ),
      }) as unknown as ComponentEntry;
      entries.set(entry.id, stored);
    }
  } catch {
    return invalid();
  }
  const components: UiBindings['components'] = Object.freeze(
    Object.fromEntries(
      [...entries].map(([id, entry]) => [
        id,
        Object.freeze({
          actions: Object.freeze(
            Object.fromEntries(
              Object.entries(entry.actions).map(([name, action]) => [
                name,
                Object.freeze({ payload: action.payload }),
              ]),
            ),
          ),
        }),
      ]),
    ),
  );
  const catalogs = buildCatalogs([...entries.values()]);
  return Object.freeze({
    catalogs: () => catalogs,
    resolve(pending: PendingInteraction): ResolvedInteraction {
      const entry = entries.get(pending.component);
      if (entry === undefined) return { ok: false, error: toErrorInfo('unsupported') };
      const validated = validateSync(entry.props, pending.props);
      if (!validated.ok) return { ok: false, error: toErrorInfo('invalid') };
      try {
        const urls = entry.urls?.(validated.value) ?? [];
        if (
          !urls.every(
            (url) =>
              typeof url === 'string' && !/[\t\n\v\f\r ]/.test(url) && isAllowedUrl(url, allowlist),
          )
        )
          return { ok: false, error: toErrorInfo('denied') };
        for (const key of entry.urlProperties ?? []) {
          const url = (validated.value as Record<string, unknown>)[key];
          if (
            url !== undefined &&
            (typeof url !== 'string' || /[\t\n\v\f\r ]/.test(url) || !isAllowedUrl(url, allowlist))
          )
            return { ok: false, error: toErrorInfo('denied') };
        }
      } catch {
        return { ok: false, error: toErrorInfo('invalid') };
      }
      return { ok: true, entry, props: validated.value };
    },
    bindings({ surfaces }: { readonly surfaces: readonly SurfaceId[] }): UiBindings {
      return Object.freeze({ components, catalogs, surfaces: Object.freeze([...surfaces]) });
    },
  });
}
