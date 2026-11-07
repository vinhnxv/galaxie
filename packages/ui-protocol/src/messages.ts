// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { ProtocolFailure } from './envelope.js';
import { copyJson, isObject } from './json.js';

export const A2UI_SPEC_VERSION = '1.0';
export const A2UI_SPEC_REVISION = 'dee8167996b0a802b18b3ebe51f3515c55b757de';

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface Component extends JsonObject {
  readonly id: string;
  readonly component: string;
}

/** Structural Standard Schema v1 contract; validators must finish synchronously. */
export interface SyncSchema<Output = unknown, Input = Output> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
    readonly validate: (
      value: unknown,
    ) =>
      | { readonly value: Output; readonly issues?: undefined }
      | { readonly issues: readonly unknown[] };
  };
}

export type RegisteredExtensions = Readonly<Record<string, SyncSchema>>;

export interface Metadata {
  readonly extensions?: JsonObject;
}
export interface CreateSurface {
  readonly surfaceId: string;
  readonly catalogId?: string;
  readonly sendDataModel?: boolean;
  readonly components?: readonly Component[];
  readonly dataModel?: JsonObject;
  readonly metadata?: Metadata;
}
export interface UpdateComponents {
  readonly surfaceId: string;
  readonly components: readonly Component[];
}
export interface UpdateDataModel {
  readonly surfaceId: string;
  readonly path?: string;
  readonly value: JsonValue;
}
export interface DeleteSurface {
  readonly surfaceId: string;
}
export type Message = { readonly version: typeof A2UI_SPEC_VERSION } & (
  | { readonly createSurface: CreateSurface }
  | { readonly updateComponents: UpdateComponents }
  | { readonly updateDataModel: UpdateDataModel }
  | { readonly deleteSurface: DeleteSurface }
);
export type ParseResult = { readonly ok: true; readonly message: Message } | ProtocolFailure;

export function schemaAccepts(schema: SyncSchema, value: unknown): boolean {
  try {
    const result = schema['~standard'].validate(copyJson(value));
    // Also reject accidentally supplied asynchronous host schemas without leaking rejections.
    if ('then' in result && typeof result.then === 'function') {
      void Promise.resolve(result).catch(() => {});
      return false;
    }
    return 'value' in result && result.issues === undefined;
  } catch {
    return false;
  }
}

export function onlyKeys(value: JsonObject, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

export function hasAgentFunction(value: JsonValue): boolean {
  const contains = (item: JsonValue): boolean => {
    if (Array.isArray(item)) return item.some(contains);
    return (
      isObject(item) &&
      (Object.hasOwn(item, 'callAgentFunction') ||
        item['@call'] === 'callAgentFunction' ||
        Object.values(item).some(contains))
    );
  };
  return (
    isObject(value) &&
    Object.entries(value).some(
      ([key, item]) =>
        key !== 'metadata' &&
        (key === 'callAgentFunction' ||
          (key === '@call' && item === 'callAgentFunction') ||
          contains(item)),
    )
  );
}

export function validMetadata(value: JsonValue, extensions: RegisteredExtensions): boolean {
  if (!isObject(value) || !onlyKeys(value, ['extensions'])) return false;
  const extra = value['extensions'];
  return (
    extra === undefined ||
    (isObject(extra) &&
      Object.entries(extra).every(
        ([name, content]) =>
          Object.hasOwn(extensions, name) && schemaAccepts(extensions[name] as SyncSchema, content),
      ))
  );
}

const MESSAGE_KEYS = [
  'createSurface',
  'updateComponents',
  'updateDataModel',
  'deleteSurface',
  'callRendererFunction',
  'agentFunctionResponse',
] as const;

/** Parses a detached, plain-JSON copy; errors contain no wire content. */
export function parseMessage(value: unknown, extensions: RegisteredExtensions = {}): ParseResult {
  let input: JsonValue;
  try {
    input = copyJson(value);
  } catch {
    return { ok: false, code: 'INVALID_MESSAGE' };
  }
  if (!isObject(input)) return { ok: false, code: 'INVALID_MESSAGE' };
  const keys = MESSAGE_KEYS.filter((key) => Object.hasOwn(input, key));
  const key = keys[0];
  if (keys.length !== 1 || key === undefined) return { ok: false, code: 'INVALID_MESSAGE' };
  if (input['version'] !== A2UI_SPEC_VERSION) return { ok: false, code: 'UNSUPPORTED_VERSION' };
  if (key === 'callRendererFunction') return { ok: false, code: 'UNSUPPORTED_RENDERER_MESSAGE' };
  if (key === 'agentFunctionResponse') return { ok: false, code: 'UNSUPPORTED_AGENT_RESPONSE' };
  const payload = input[key];
  if (!isObject(payload)) return { ok: false, code: 'INVALID_MESSAGE' };
  if (key === 'createSurface' && Object.hasOwn(payload, 'theme')) {
    return { ok: false, code: 'UNSUPPORTED_THEME' };
  }
  if (key === 'createSurface' && payload['sendDataModel'] === false) {
    return { ok: false, code: 'DATA_MODEL_REQUIRED' };
  }
  if (Array.isArray(payload['components']) && payload['components'].some(hasAgentFunction)) {
    return { ok: false, code: 'UNSUPPORTED_AGENT_FUNCTION' };
  }
  const fields =
    key === 'createSurface'
      ? ['surfaceId', 'catalogId', 'sendDataModel', 'components', 'dataModel', 'metadata']
      : key === 'updateComponents'
        ? ['surfaceId', 'components']
        : key === 'updateDataModel'
          ? ['surfaceId', 'path', 'value']
          : ['surfaceId'];
  if (!onlyKeys(input, ['version', key]) || !onlyKeys(payload, fields)) {
    return { ok: false, code: 'UNKNOWN_FIELD' };
  }
  if (payload['metadata'] !== undefined && !validMetadata(payload['metadata'], extensions)) {
    return { ok: false, code: 'UNKNOWN_FIELD' };
  }
  if (
    typeof payload['surfaceId'] !== 'string' ||
    payload['surfaceId'].length === 0 ||
    (payload['catalogId'] !== undefined && typeof payload['catalogId'] !== 'string') ||
    (payload['sendDataModel'] !== undefined && typeof payload['sendDataModel'] !== 'boolean') ||
    (payload['path'] !== undefined && typeof payload['path'] !== 'string') ||
    (key === 'updateDataModel' && !Object.hasOwn(payload, 'value')) ||
    (payload['dataModel'] !== undefined && !isObject(payload['dataModel'])) ||
    (key === 'updateComponents' && !Array.isArray(payload['components']))
  )
    return { ok: false, code: 'INVALID_MESSAGE' };
  if (payload['components'] !== undefined) {
    if (!Array.isArray(payload['components'])) return { ok: false, code: 'INVALID_MESSAGE' };
    for (const component of payload['components']) {
      if (
        !isObject(component) ||
        typeof component['id'] !== 'string' ||
        component['id'].length === 0 ||
        typeof component['component'] !== 'string' ||
        component['component'].length === 0
      )
        return { ok: false, code: 'INVALID_MESSAGE' };
      if (component['metadata'] !== undefined && !validMetadata(component['metadata'], extensions))
        return { ok: false, code: 'UNKNOWN_FIELD' };
    }
  }
  return { ok: true, message: input as unknown as Message };
}
