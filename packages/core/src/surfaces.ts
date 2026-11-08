// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  A2UI_SPEC_REVISION,
  A2UI_SPEC_VERSION,
  type Catalog,
  type MaterializedSurface,
  PROTOCOL_ERROR_CATEGORY,
  type ProtocolErrorCode,
  reduceBatch,
  type SurfaceContext,
  type SurfaceResult,
  validateSurface,
} from '@galaxie-ai/ui-protocol';
import { type ErrorCode, GalaxieError, toErrorInfo } from './errors.js';
import type { InteractionId, SurfaceId, ViewRevision } from './ids.js';
import {
  type ComponentId,
  checkInteractionUrlPolicy,
  type InteractionRequest,
  isComponentId,
  type PendingInteraction,
} from './interactions.js';
import type { DataLabel } from './policy.js';
import { copyRecoveryJson, type RecoveryJson } from './recovery.js';

export type PendingSurface = MaterializedSurface & {
  readonly viewRevision: ViewRevision;
  readonly labels: readonly DataLabel[];
};

function object(value: unknown): value is Record<string, unknown> {
  return (
    value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
  );
}

/** Recovery's object checks plus strict arrays: never invoke array getters or toJSON hooks. */
export function copySurfaceJson(value: unknown): RecoveryJson {
  const ancestors = new Set<object>();
  const inspect = (current: unknown): void => {
    if (current === null || typeof current !== 'object') return;
    if (ancestors.has(current)) throw new GalaxieError('invalid', toErrorInfo('invalid').message);
    ancestors.add(current);
    const array = Array.isArray(current);
    const keys = Reflect.ownKeys(current);
    if (
      array &&
      (Object.getPrototypeOf(current) !== Array.prototype || keys.length !== current.length + 1)
    )
      throw new GalaxieError('invalid', toErrorInfo('invalid').message);
    for (const key of keys) {
      if (array && key === 'length') continue;
      const field = Object.getOwnPropertyDescriptor(current, key);
      if (
        array &&
        (typeof key !== 'string' ||
          !/^(0|[1-9]\d*)$/.test(key) ||
          Number(key) >= current.length ||
          field === undefined ||
          field.enumerable !== true ||
          !('value' in field))
      )
        throw new GalaxieError('invalid', toErrorInfo('invalid').message);
      if (field !== undefined && 'value' in field) inspect(field.value);
    }
    ancestors.delete(current);
  };
  inspect(value);
  return copyRecoveryJson(value);
}

/** Shape only: catalogs, pins and policy are checked again by core before publication. */
export function parseSurfaceRecord(value: unknown): MaterializedSurface | undefined {
  try {
    const record = copySurfaceJson(value);
    if (!object(record) || record['format'] !== 'galaxie.surface/1') return undefined;
    const keys = [
      'format',
      'region',
      'a2uiSurfaceId',
      'catalogId',
      'revision',
      'specVersion',
      'specRevision',
      'status',
      'components',
      'dataModel',
    ];
    if (
      Object.keys(record).length !== keys.length ||
      Object.keys(record).some((key) => !keys.includes(key)) ||
      ['region', 'a2uiSurfaceId', 'catalogId', 'specVersion', 'specRevision'].some((key) => {
        const field = record[key];
        return typeof field !== 'string' || field.length === 0;
      }) ||
      typeof record['revision'] !== 'number' ||
      !Number.isSafeInteger(record['revision']) ||
      record['revision'] < 1 ||
      !['live', 'deleted'].includes(String(record['status'])) ||
      !object(record['components']) ||
      !object(record['dataModel'])
    )
      return undefined;
    for (const [id, component] of Object.entries(record['components'])) {
      if (
        !object(component) ||
        component['id'] !== id ||
        id.length === 0 ||
        typeof component['component'] !== 'string'
      )
        return undefined;
    }
    return record as unknown as MaterializedSurface;
  } catch {
    return undefined;
  }
}

function freeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Opaque token, determined only by the A2UI identity and numeric revision. */
export function surfaceViewRevision(record: MaterializedSurface): ViewRevision {
  return `${record.a2uiSurfaceId}#${record.revision}` as ViewRevision;
}

export function surfaceComponentId(catalogId: string, name: string): ComponentId {
  const versionAt = catalogId.lastIndexOf('/v');
  return `${catalogId.slice(0, versionAt)}.${name}${catalogId.slice(versionAt)}` as ComponentId;
}

function componentName(component: ComponentId, catalogId: string): string | undefined {
  const dot = component.indexOf('.');
  const versionAt = component.lastIndexOf('/v');
  const name = component.slice(dot + 1, versionAt);
  return isComponentId(component) && surfaceComponentId(catalogId, name) === component
    ? name
    : undefined;
}

/** Project root props without component identity, accessibility or renderer metadata. */
export function pendingFromSurface(
  interactionId: InteractionId,
  record: MaterializedSurface,
): PendingInteraction {
  const copy = parseSurfaceRecord(record);
  if (copy === undefined) throw new GalaxieError('invalid', toErrorInfo('invalid').message);
  const root = copy.components['root'];
  const props = Object.fromEntries(
    Object.entries(root ?? {}).filter(
      ([key]) => !['id', 'component', 'accessibility', 'metadata'].includes(key),
    ),
  );
  const viewRevision = surfaceViewRevision(copy);
  return freeze({
    interactionId,
    surfaceId: copy.region as SurfaceId,
    viewRevision,
    component: surfaceComponentId(copy.catalogId, root?.component ?? ''),
    props,
    surface: { ...copy, viewRevision, labels: [] },
  });
}

/** Compatibility conversion for a future renderer; legacy publication does not use it. */
export function surfaceFromRequest(
  request: InteractionRequest,
  catalogId: string,
): MaterializedSurface | undefined {
  const name = componentName(request.component, catalogId);
  if (
    name === undefined ||
    Object.hasOwn(request.props, 'id') ||
    Object.hasOwn(request.props, 'component')
  )
    return undefined;
  return parseSurfaceRecord({
    format: 'galaxie.surface/1',
    region: request.surfaceId,
    a2uiSurfaceId: request.surfaceId,
    catalogId,
    revision: 1,
    specVersion: A2UI_SPEC_VERSION,
    specRevision: A2UI_SPEC_REVISION,
    status: 'live',
    components: { root: { id: 'root', component: name, ...request.props } },
    dataModel: {},
  });
}

export function protocolCategory(code: ProtocolErrorCode): ErrorCode {
  return PROTOCOL_ERROR_CATEGORY[code];
}

/** Agent-author convenience only. Receipt and restore still run core's publication gate. */
export function materializeSurface(
  input: SurfaceContext & {
    readonly previous?: MaterializedSurface;
    readonly messages: readonly unknown[];
  },
): MaterializedSurface {
  const result = reduceBatch(input.previous, input.messages, input);
  if (!result.ok) {
    const code = protocolCategory(result.code);
    throw new GalaxieError(code, toErrorInfo(code).message);
  }
  return freeze(result.surface);
}

export interface SurfaceValidator {
  readonly specVersion: string;
  readonly specRevision: string;
  readonly validate: (record: unknown, context: SurfaceContext) => SurfaceResult;
}

/** Internal injection seam: each historical pin keeps its own validation semantics. */
export function createSurfacePolicy(
  options: { readonly validators?: readonly SurfaceValidator[] } = {},
): { readonly validate: (record: MaterializedSurface, context: SurfaceContext) => SurfaceResult } {
  const validators = new Map(
    (
      options.validators ?? [
        {
          specVersion: A2UI_SPEC_VERSION,
          specRevision: A2UI_SPEC_REVISION,
          validate: validateSurface,
        },
      ]
    ).map((entry) => [JSON.stringify([entry.specVersion, entry.specRevision]), entry.validate]),
  );
  return {
    validate(record, context): SurfaceResult {
      const validator = validators.get(JSON.stringify([record.specVersion, record.specRevision]));
      if (validator === undefined) return { ok: false, code: 'UNSUPPORTED_VERSION' };
      try {
        return validator(record, context);
      } catch {
        return { ok: false, code: 'INVALID_MESSAGE' };
      }
    },
  };
}

export function checkSurfaceUrls(
  record: MaterializedSurface,
  allowlist: readonly string[],
  privateValues?: ReadonlySet<string>,
): boolean {
  return checkInteractionUrlPolicy(
    { components: record.components, dataModel: record.dataModel },
    allowlist,
    privateValues,
  );
}

function pointer(value: string): readonly string[] | undefined {
  if (value === '') return [];
  if (!value.startsWith('/') || /~(?:[^01]|$)/.test(value)) return undefined;
  return value
    .slice(1)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
}

/** Coarse writable rule: related ancestor/descendant bindings authorize a changed path. */
export function surfaceModelChanges(
  surface: MaterializedSurface,
  submitted: unknown,
  catalog?: Catalog,
):
  | {
      readonly model: Readonly<Record<string, unknown>>;
      readonly privateStrings: readonly string[];
    }
  | undefined {
  let model: unknown;
  try {
    model = copySurfaceJson(submitted);
  } catch {
    return undefined;
  }
  if (!object(model)) return undefined;
  const bindings: Array<readonly string[]> = [];
  const collect = (value: unknown, scope?: readonly string[]): void => {
    if (value === null || typeof value !== 'object') return;
    if (object(value) && typeof value['@path'] === 'string') {
      const path = value['@path'];
      const absolute = path === '' || path.startsWith('/');
      const parsed = pointer(absolute ? path : `/${path}`);
      const parts = absolute
        ? parsed
        : scope === undefined || parsed === undefined
          ? undefined
          : [...scope, ...parsed];
      if (parts !== undefined) bindings.push(parts);
    }
    for (const child of Object.values(value)) collect(child, scope);
  };
  const seen = new Set<string>();
  const visit = (id: string, scope?: readonly string[]): void => {
    const identity = JSON.stringify([id, scope]);
    if (seen.has(identity)) return;
    seen.add(identity);
    const component = surface.components[id];
    if (component === undefined) return;
    for (const [key, value] of Object.entries(component)) {
      if (!['id', 'component', 'catalogId', 'metadata'].includes(key)) collect(value, scope);
    }
    const definition = catalog?.components[component.component];
    for (const key of definition?.child ?? []) {
      const target = component[key];
      if (typeof target === 'string') visit(target, scope);
    }
    for (const key of definition?.children ?? []) {
      const children = component[key];
      if (Array.isArray(children)) {
        for (const target of children) if (typeof target === 'string') visit(target, scope);
      } else if (
        object(children) &&
        typeof children['componentId'] === 'string' &&
        typeof children['path'] === 'string'
      ) {
        const path = children['path'];
        const relative = pointer(path.startsWith('/') || path === '' ? path : `/${path}`);
        if (relative === undefined || (!path.startsWith('/') && path !== '' && scope === undefined))
          continue;
        const parts =
          path.startsWith('/') || path === '' ? relative : [...(scope ?? []), ...relative];
        let values: unknown = surface.dataModel;
        for (const part of parts) {
          values =
            values !== null && typeof values === 'object' && Object.hasOwn(values, part)
              ? (values as Record<string, unknown>)[part]
              : undefined;
        }
        if (Array.isArray(values))
          for (let index = 0; index < values.length; index++) {
            visit(children['componentId'], [...parts, String(index)]);
          }
      }
    }
  };
  for (const id of Object.keys(surface.components)) visit(id);
  const privateStrings: string[] = [];
  const allowed = (path: readonly string[]): boolean =>
    bindings.some((binding) =>
      path
        .slice(0, Math.min(path.length, binding.length))
        .every((part, index) => part === binding[index]),
    );
  const compare = (before: unknown, after: unknown, path: readonly string[]): boolean => {
    if (before === after) return true;
    if (typeof after === 'string') privateStrings.push(after);
    if ((object(before) && object(after)) || (Array.isArray(before) && Array.isArray(after))) {
      const left = before as Record<string, unknown>;
      const right = after as Record<string, unknown>;
      return [...new Set([...Object.keys(left), ...Object.keys(right)])].every((key) =>
        compare(
          Object.hasOwn(left, key) ? left[key] : undefined,
          Object.hasOwn(right, key) ? right[key] : undefined,
          [...path, key],
        ),
      );
    }
    if (after !== null && typeof after === 'object') {
      const strings = (value: unknown): void => {
        if (typeof value === 'string') privateStrings.push(value);
        else if (value !== null && typeof value === 'object') Object.values(value).forEach(strings);
      };
      strings(after);
    }
    return allowed(path);
  };
  return compare(surface.dataModel, model, []) ? { model, privateStrings } : undefined;
}
