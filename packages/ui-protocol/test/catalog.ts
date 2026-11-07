// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type {
  Catalog,
  Component,
  JsonObject,
  MaterializedSurface,
  ProtocolErrorCode,
  SurfaceContext,
  SurfaceResult,
  SyncSchema,
} from '../src/index.js';
import { reduceBatch } from '../src/index.js';

export const CATALOG_ID = 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json';

export function schema(predicate: (value: Record<string, unknown>) => boolean): SyncSchema {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate(value: unknown) {
        return value !== null &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          predicate(value as Record<string, unknown>)
          ? { value }
          : { issues: [] };
      },
    },
  };
}
const keys = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key));
const textValue = (value: unknown): boolean =>
  typeof value === 'string' ||
  (value !== null &&
    typeof value === 'object' &&
    ('@call' in value ||
      ('@path' in value && Object.keys(value).length === 1 && typeof value['@path'] === 'string')));
const list = schema(
  (value) =>
    keys(value, ['children']) &&
    (Array.isArray(value['children']) ||
      (value['children'] !== null && typeof value['children'] === 'object')),
);
export const catalog: Catalog = {
  id: CATALOG_ID,
  components: {
    Column: { props: list, children: ['children'] },
    List: { props: list, children: ['children'] },
    Card: {
      props: schema((v) => keys(v, ['child']) && typeof v['child'] === 'string'),
      child: ['child'],
    },
    Text: {
      props: schema((v) => keys(v, ['text']) && textValue(v['text'])),
      bindable: ['text'],
    },
    Image: {
      props: schema((v) => keys(v, ['url']) && typeof v['url'] === 'string'),
      urls: ['url'],
    },
    Button: {
      props: schema(
        (v) => keys(v, ['action']) && v['action'] !== null && typeof v['action'] === 'object',
      ),
    },
  },
  functions: {
    format: {
      allowedCallers: 'rendererOrAgent',
      args: schema((v) => keys(v, ['text']) && typeof v['text'] === 'string'),
    },
    secret: { allowedCallers: 'agentOnly', args: schema(() => true) },
    open: {
      allowedCallers: 'rendererOnly',
      requiresUserActivation: true,
      args: schema(() => true),
    },
  },
};
export const context: SurfaceContext = {
  binding: { region: 'main', a2uiSurfaceId: 'user_profile_card', catalogId: CATALOG_ID },
  catalog,
  limits: { payloadBytes: 1_048_576, components: 50 },
  isAllowedUrl: (url) => url.startsWith('https://images.example/'),
};
export function create(
  components: readonly Component[] = [{ id: 'root', component: 'Text', text: 'Hello' }],
  dataModel: JsonObject = {},
): unknown {
  return {
    version: '1.0',
    createSurface: { surfaceId: context.binding.a2uiSurfaceId, components, dataModel },
  };
}
export function update(components: readonly Component[]): unknown {
  return {
    version: '1.0',
    updateComponents: { surfaceId: context.binding.a2uiSurfaceId, components },
  };
}
export function data(value: unknown, path?: string): unknown {
  return {
    version: '1.0',
    updateDataModel: {
      surfaceId: context.binding.a2uiSurfaceId,
      value,
      ...(path === undefined ? {} : { path }),
    },
  };
}
export const deletion: unknown = {
  version: '1.0',
  deleteSurface: { surfaceId: context.binding.a2uiSurfaceId },
};
export function surface(result: SurfaceResult): MaterializedSurface {
  if (!result.ok) throw new Error(result.code);
  return result.surface;
}
export function run(
  components: readonly Component[],
  dataModel: JsonObject = {},
  options: SurfaceContext = context,
): SurfaceResult {
  return reduceBatch(undefined, [create(components, dataModel)], options);
}
export function code(result: SurfaceResult): ProtocolErrorCode | undefined {
  return result.ok ? undefined : result.code;
}
export function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
  }
  return Object.freeze(value);
}
