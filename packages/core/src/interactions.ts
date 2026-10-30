// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { type ErrorInfo, GalaxieError } from './errors.js';
import type { InstanceId, InteractionId, RunId, SurfaceId, ViewRevision } from './ids.js';
import { containsPrivateEncoded } from './private-values.js';
import { isStandardSchema, type StandardSchema } from './schema.js';
import { isHttpDestination } from './urls.js';

/** A component catalog, for example `education/v1` (brief §11.2). */
export type CatalogId = `${string}/v${number}`;

/** A catalog component, for example `education.Quiz/v1` (ADR-0007). */
export type ComponentId = `${string}.${string}/v${number}`;

/** Shared component-ID syntax for requests and host registries. */
export function isComponentId(value: unknown): value is ComponentId {
  return typeof value === 'string' && /^[A-Za-z][\w-]*\.[A-Za-z][\w-]*\/v\d+$/.test(value);
}

/** Host-owned UI contracts, independent of a renderer. */
export interface UiBindings {
  readonly components: Readonly<
    Record<
      ComponentId,
      { readonly actions: Readonly<Record<string, { readonly payload: StandardSchema }>> }
    >
  >;
  readonly surfaces: readonly SurfaceId[];
}

export function normalizeUiBindings(bindings: UiBindings): UiBindings {
  const invalid = (): never => {
    throw new GalaxieError('invalid', 'The UI bindings are invalid.');
  };
  try {
    if (
      bindings === null ||
      typeof bindings !== 'object' ||
      bindings.components === null ||
      typeof bindings.components !== 'object' ||
      Array.isArray(bindings.components) ||
      !Array.isArray(bindings.surfaces) ||
      Array.from(bindings.surfaces).some(
        (surface) => typeof surface !== 'string' || surface.length === 0,
      ) ||
      new Set(bindings.surfaces).size !== bindings.surfaces.length
    )
      invalid();
    const components = Object.fromEntries(
      Object.entries(bindings.components).map(([id, entry]) => {
        if (
          !isComponentId(id) ||
          entry === null ||
          typeof entry !== 'object' ||
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
              !isStandardSchema(action.payload)
            )
              invalid();
            return [name, Object.freeze({ payload: action.payload })];
          }),
        );
        return [id, Object.freeze({ actions: Object.freeze(actions) })];
      }),
    );
    return Object.freeze({
      components: Object.freeze(components),
      surfaces: Object.freeze([...bindings.surfaces]),
    });
  } catch {
    return invalid();
  }
}

export function checkUiRequirements(bindings: UiBindings, requirements: UiRequirements): boolean {
  const versionAt = requirements.catalog.lastIndexOf('/v');
  const catalog = requirements.catalog.slice(0, versionAt);
  const version = requirements.catalog.slice(versionAt);
  return (
    requirements.components.every((name) =>
      Object.hasOwn(bindings.components, `${catalog}.${name}${version}`),
    ) && requirements.surfaces.every((surface) => bindings.surfaces.includes(surface))
  );
}

export function checkInteractionBindings(
  bindings: UiBindings,
  pending: PendingInteraction,
): boolean {
  return (
    Object.hasOwn(bindings.components, pending.component) &&
    Object.keys(bindings.components[pending.component]?.actions ?? {}).length > 0 &&
    bindings.surfaces.includes(pending.surfaceId)
  );
}

/** The JSON display request carried by a checkpoint interrupt. */
export interface InteractionRequest {
  readonly surfaceId: SurfaceId;
  readonly viewRevision: ViewRevision;
  readonly component: ComponentId;
  readonly props: Readonly<Record<string, unknown>>;
}

/** The value returned to an interrupting node after dispatch. */
export interface Submission {
  readonly action: string;
  readonly payload: unknown;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
  );
}

function json(value: unknown, ancestors: Set<object>): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!Array.isArray(value) && !plainObject(value)) return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? Array.from(value).every((item) => json(item, ancestors))
    : Reflect.ownKeys(value).every((key) => {
        const field = Object.getOwnPropertyDescriptor(value, key);
        return (
          typeof key === 'string' &&
          field?.enumerable === true &&
          'value' in field &&
          json(field.value, ancestors)
        );
      });
  ancestors.delete(value);
  return valid;
}

/** Parses only the four-field plain JSON request; never includes its value in a failure. */
export function parseInteractionRequest(value: unknown): InteractionRequest | undefined {
  try {
    if (!plainObject(value) || Reflect.ownKeys(value).length !== 4 || !json(value, new Set()))
      return undefined;
    if (
      typeof value['surfaceId'] !== 'string' ||
      value['surfaceId'].length === 0 ||
      typeof value['viewRevision'] !== 'string' ||
      value['viewRevision'].length === 0 ||
      !isComponentId(value['component']) ||
      !plainObject(value['props'])
    )
      return undefined;
    return value as unknown as InteractionRequest;
  } catch {
    return undefined;
  }
}

/** Shared with schema-declared URL props in the renderer: exact origins, no user information. */
export function isAllowedUrl(value: string, allowlist: readonly string[]): boolean {
  try {
    const url = new URL(value);
    return (
      isHttpDestination(url) &&
      url.username === '' &&
      url.password === '' &&
      allowlist.includes(url.origin)
    );
  } catch {
    return false;
  }
}

function urlCandidate(value: string): string | undefined {
  const stripped = value.replace(/[\t\n\r]/g, '');
  let start = 0;
  let end = stripped.length;
  while (start < end && stripped.charCodeAt(start) <= 0x20) start++;
  while (end > start && stripped.charCodeAt(end - 1) <= 0x20) end--;
  const candidate = stripped.slice(start, end);
  return /^[/\\]{2}/.test(candidate) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(candidate) ||
    /^(?:https?|wss?|ftp|file|javascript|vbscript|data|blob|filesystem):/i.test(candidate)
    ? candidate
    : undefined;
}

/** M1 examines every JSON string leaf; the M2 registry will identify URL props by schema. */
export function checkInteractionUrls(props: unknown, allowlist: readonly string[]): boolean {
  return checkInteractionUrlPolicy(props, allowlist);
}

export function checkInteractionUrlPolicy(
  props: unknown,
  allowlist: readonly string[],
  privateValues?: ReadonlySet<string>,
): boolean {
  try {
    if (typeof props === 'string') {
      const candidate = urlCandidate(props);
      if (candidate === undefined) return true;
      if (!isAllowedUrl(candidate, allowlist)) return false;
      if (privateValues !== undefined && privateValues.size > 0) {
        for (const raw of props === candidate ? [props] : [props, candidate]) {
          if (containsPrivateEncoded(raw, privateValues)) return false;
        }
      }
      return true;
    }
    if (Array.isArray(props))
      return props.every((value) => checkInteractionUrlPolicy(value, allowlist, privateValues));
    return (
      props === null ||
      typeof props !== 'object' ||
      Object.values(props).every((value) =>
        checkInteractionUrlPolicy(value, allowlist, privateValues),
      )
    );
  } catch {
    return false;
  }
}

/** The UI a definition needs. The host reports what it supports before a run (brief §11.2). */
export interface UiRequirements {
  readonly catalog: CatalogId;
  /** Component names in the catalog, for example `Quiz`. */
  readonly components: readonly string[];
  readonly surfaces: readonly SurfaceId[];
}

/**
 * An interaction waiting for the user. The graph builds it deterministically, and the host reads it
 * from the checkpoint interrupt, including after a reload (ADR-0004).
 */
export interface PendingInteraction {
  readonly interactionId: InteractionId;
  readonly surfaceId: SurfaceId;
  readonly viewRevision: ViewRevision;
  readonly component: ComponentId;
  /** Validated against the registry's props schema before rendering (ADR-0007). */
  readonly props: unknown;
}

/** A user event. Every identity field is checked against the pending interrupt (brief §12.2). */
export interface UserInteractionEvent {
  readonly instanceId: InstanceId;
  readonly runId: RunId;
  readonly interactionId: InteractionId;
  readonly surfaceId: SurfaceId;
  readonly viewRevision: ViewRevision;
  /** A registered action name. Action labels and confirmation text come from the registry (ADR-0007). */
  readonly action: string;
  readonly payload: unknown;
}

/** The answer to a dispatched event. M1 acceptance is in-memory only (ADR-0004). */
export type DispatchReceipt =
  | { readonly status: 'accepted'; readonly interactionId: InteractionId }
  | { readonly status: 'rejected'; readonly error: ErrorInfo };

/** Submission inbox status. A consumed entry is the receipt (brief §12.1). */
export type InboxStatus = 'accepted' | 'consumed';
