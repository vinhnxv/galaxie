// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readAnnotations } from '../annotations.js';
import type { HttpCapabilityOptions } from '../capabilities.js';
import type { AgentDefinition } from '../definition.js';
import { GalaxieError } from '../errors.js';
import { getHttpCapability, httpCapability } from '../http-capability.js';
import type { ModelRouting } from '../models.js';
import { isHttpDestination, isLoopback, normalizeUrlAllowlist } from '../urls.js';
import { HostConfigError, pointer } from './errors.js';
import { type HostConfigDocument, hostConfigSchema } from './schema.js';

/** Named host functions; validation snapshots the records without calling the functions. */
export interface HostConfigHooks {
  readonly headers?: Readonly<Record<string, NonNullable<HttpCapabilityOptions['headers']>>>;
  readonly fetch?: Readonly<Record<string, typeof globalThis.fetch>>;
  readonly token?: Readonly<
    Record<
      string,
      (request: {
        readonly principalScope: string;
        readonly signal: AbortSignal;
      }) => string | Promise<string>
    >
  >;
  readonly getCredential?: Readonly<Record<string, NonNullable<ModelRouting['getCredential']>>>;
  readonly consent?: Readonly<Record<string, NonNullable<ModelRouting['consent']>>>;
  readonly availability?: Readonly<Record<string, NonNullable<ModelRouting['availability']>>>;
  readonly download?: Readonly<Record<string, NonNullable<ModelRouting['download']>>>;
}

declare const configurationType: unique symbol;

type RequiredNames<Value> = keyof {
  [Name in keyof Value as Record<never, never> extends Pick<Value, Name> ? never : Name]: unknown;
};

type CapabilityNames<Document> = [Document] extends [{ readonly capabilities: infer Capabilities }]
  ? Extract<RequiredNames<Capabilities>, string>
  : never;

/** Only values returned by validateHostConfig can be passed to the builders. */
export interface ValidatedHostConfig<
  Definition extends AgentDefinition = AgentDefinition,
  Names extends string = never,
> {
  readonly document: HostConfigDocument;
  readonly hooks: HostConfigHooks;
  readonly [configurationType]?: readonly [Definition, (name: Names) => void];
}

const validated = new WeakSet<object>();

export function assertValidatedHostConfig(value: object): void {
  if (!validated.has(value)) throw new HostConfigError('invalid', '');
}

export function copyDocument<Value>(value: Value): Value {
  if (Array.isArray(value)) return value.map(copyDocument) as Value;
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .map(([key, child]) => [key, copyDocument(child)]),
    ) as Value;
  return value;
}

function freeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function rejectPrototypeKeys(
  value: unknown,
  parts: readonly PropertyKey[] = [],
  seen = new WeakSet<object>(),
): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Object.hasOwn(value, '__proto__')) throw new HostConfigError('invalid', pointer(parts));
  for (const [key, child] of Object.entries(value))
    rejectPrototypeKeys(child, [...parts, key], seen);
}

function resolveUrl(value: string, base: URL, path: string): string {
  try {
    if (/[\s\\]/.test(value)) throw new HostConfigError('invalid', path);
    const relative = value.startsWith('/');
    if (relative && (value.startsWith('//') || new URL(value, base).origin !== base.origin))
      throw new HostConfigError('invalid', path);
    const resolved = relative ? base.origin + value : value;
    const url = new URL(resolved);
    if (url.username !== '' || url.password !== '') throw new HostConfigError('invalid', path);
    return resolved;
  } catch {
    throw new HostConfigError('invalid', path);
  }
}

function snapshotHooks(hooks: HostConfigHooks): HostConfigHooks {
  return freeze(
    Object.fromEntries(
      Object.getOwnPropertyNames(hooks).map((group) => {
        const functions = hooks[group as keyof HostConfigHooks];
        return [
          group,
          Object.fromEntries(
            Object.getOwnPropertyNames(functions ?? {}).map((name) => [name, functions?.[name]]),
          ),
        ];
      }),
    ),
  );
}

/** Pure validation against a definition and host-owned hook names, before any runtime exists. */
export function validateHostConfig<const Document, const Definition extends AgentDefinition>(
  supplied: Document,
  definition: Definition,
  hooks: HostConfigHooks,
  baseURL: string,
): ValidatedHostConfig<Definition, CapabilityNames<Document>> {
  const version =
    supplied !== null && typeof supplied === 'object' && Object.hasOwn(supplied, 'version')
      ? (supplied as { version?: unknown }).version
      : undefined;
  if (version !== '0.1')
    throw new HostConfigError(typeof version === 'string' ? 'unsupported' : 'invalid', '/version');
  rejectPrototypeKeys(supplied);
  const parsed = hostConfigSchema.safeParse(supplied);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const parts =
      issue?.code === 'unrecognized_keys'
        ? [...issue.path, issue.keys[0] ?? '']
        : issue?.code === 'invalid_key'
          ? issue.path.slice(0, -1)
          : (issue?.path ?? []);
    throw new HostConfigError('invalid', pointer(parts));
  }
  const data = parsed.data;
  const hook = (group: keyof HostConfigHooks, name: string | undefined, path: string): void => {
    if (name === undefined) return;
    const record = Object.hasOwn(hooks, group) ? hooks[group] : undefined;
    if (record === undefined || !Object.hasOwn(record, name) || typeof record[name] !== 'function')
      throw new HostConfigError('invalid', path);
  };
  for (const [name, capability] of Object.entries(data.capabilities ?? {})) {
    hook('headers', capability.headers, pointer(['capabilities', name, 'headers']));
    hook('fetch', capability.fetch, pointer(['capabilities', name, 'fetch']));
  }
  for (const [id, provider] of Object.entries(data.models?.providers ?? {}))
    hook(
      'fetch',
      provider.endpoint?.fetch,
      pointer(['models', 'providers', id, 'endpoint', 'fetch']),
    );
  for (const name of ['getCredential', 'consent', 'availability', 'download'] as const)
    hook(name, data.models?.[name], pointer(['models', name]));
  for (const [name, server] of Object.entries(data.mcp?.servers ?? {})) {
    hook('token', server.token, pointer(['mcp', 'servers', name, 'token']));
    hook('fetch', server.fetch, pointer(['mcp', 'servers', name, 'fetch']));
  }
  let base: URL;
  try {
    base = new URL(baseURL);
    if (
      !['http:', 'https:'].includes(base.protocol) ||
      base.username !== '' ||
      base.password !== '' ||
      /[\s\\]/.test(baseURL)
    )
      throw new HostConfigError('invalid', '');
  } catch {
    throw new HostConfigError('invalid', '');
  }
  for (const [name, capability] of Object.entries(data.capabilities ?? {})) {
    const path = pointer(['capabilities', name]);
    Object.assign(capability, { url: resolveUrl(capability.url, base, path) });
  }
  for (const [id, provider] of Object.entries(data.models?.providers ?? {})) {
    const endpoint = provider.endpoint;
    if (endpoint !== undefined)
      Object.assign(endpoint, {
        baseURL: resolveUrl(endpoint.baseURL, base, pointer(['models', 'providers', id])),
      });
  }
  for (const [name, server] of Object.entries(data.mcp?.servers ?? {})) {
    const path = pointer(['mcp', 'servers', name]);
    Object.assign(server, { url: resolveUrl(server.url, base, path) });
    if (!isHttpDestination(new URL(server.url))) throw new HostConfigError('invalid', path);
  }
  if (data.limits?.urlAllowlist !== undefined) {
    try {
      normalizeUrlAllowlist(data.limits.urlAllowlist);
    } catch {
      throw new HostConfigError('invalid', '/limits/urlAllowlist');
    }
  }
  const requests = new Map([
    ...Object.entries(definition.capabilities?.required ?? {}),
    ...Object.entries(definition.capabilities?.optional ?? {}),
  ]);
  for (const name of Object.keys(data.capabilities ?? {}))
    if (!requests.has(name)) throw new HostConfigError('invalid', pointer(['capabilities', name]));
  for (const [role, route] of Object.entries(data.models?.roles ?? {})) {
    const path = pointer(['models', 'roles', role]);
    if (!Object.hasOwn(definition.models ?? {}, role)) throw new HostConfigError('invalid', path);
    for (const [index, id] of route.providers.entries())
      if (!Object.hasOwn(data.models?.providers ?? {}, id))
        throw new HostConfigError('invalid', `${path}/providers/${index}`);
  }
  for (const [name, server] of Object.entries(data.mcp?.servers ?? {}))
    for (const [tool, config] of Object.entries(server.tools)) {
      const path = pointer(['mcp', 'servers', name, 'tools', tool]);
      if (
        !requests.has(`mcp.${name}.${tool}@${config.version}`) ||
        (config.kind === 'write' && config.approval !== 'confirm')
      )
        throw new HostConfigError('invalid', path);
    }
  for (const [name, capability] of Object.entries(data.capabilities ?? {})) {
    const path = pointer(['capabilities', name]);
    try {
      const { headers: _headers, fetch: _fetch, ...options } = capability;
      const binding = httpCapability(copyDocument(options) as HttpCapabilityOptions);
      const request = requests.get(name);
      if (request !== undefined) {
        let annotations: ReturnType<typeof readAnnotations>;
        try {
          annotations = readAnnotations(request.input);
        } catch (error) {
          throw new HostConfigError(error instanceof GalaxieError ? error.code : 'invalid', path);
        }
        getHttpCapability(binding)?.validate(annotations, binding);
      }
    } catch (error) {
      if (error instanceof HostConfigError) throw error;
      if (error instanceof GalaxieError) throw new HostConfigError(error.code, path, error);
      throw new HostConfigError('invalid', path);
    }
  }
  for (const [id, provider] of Object.entries(data.models?.providers ?? {})) {
    const endpoint = provider.endpoint;
    if (endpoint === undefined) continue;
    const url = new URL(endpoint.baseURL);
    if (
      provider.destination === 'in-browser' ||
      (provider.destination === 'user-device' && !isLoopback(url.hostname)) ||
      !isHttpDestination(url) ||
      /[?#]/.test(endpoint.baseURL)
    )
      throw new HostConfigError('invalid', pointer(['models', 'providers', id]));
  }
  const result = freeze({ document: data, hooks: snapshotHooks(hooks) });
  validated.add(result);
  return result;
}
