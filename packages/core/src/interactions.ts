// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { ErrorInfo } from './errors.js';
import type { InstanceId, InteractionId, RunId, SurfaceId, ViewRevision } from './ids.js';
import { isHttpDestination } from './urls.js';

/** A component catalog, for example `education/v1` (brief §11.2). */
export type CatalogId = `${string}/v${number}`;

/** A catalog component, for example `education.Quiz/v1` (ADR-0007). */
export type ComponentId = `${string}.${string}/v${number}`;

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
      typeof value['component'] !== 'string' ||
      !/^[A-Za-z][\w-]*\.[A-Za-z][\w-]*\/v\d+$/.test(value['component']) ||
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
  try {
    if (typeof props === 'string') {
      const candidate = urlCandidate(props);
      return candidate === undefined || isAllowedUrl(candidate, allowlist);
    }
    if (Array.isArray(props)) return props.every((value) => checkInteractionUrls(value, allowlist));
    return (
      props === null ||
      typeof props !== 'object' ||
      Object.values(props).every((value) => checkInteractionUrls(value, allowlist))
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
