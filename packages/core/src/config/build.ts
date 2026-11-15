// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { CapabilityBinding, HttpCapabilityOptions } from '../capabilities.js';
import { httpCapability } from '../http-capability.js';
import type { ModelDescriptor, ModelRouting } from '../models.js';
import type { RuntimeOptions } from '../runtime.js';
import { HostConfigError, pointer } from './errors.js';
import { assertValidatedHostConfig, copyDocument, type ValidatedHostConfig } from './validate.js';

interface Endpoint {
  readonly baseURL: string;
  readonly model: string;
  readonly destination: ModelDescriptor['destination'];
  readonly fetch?: typeof globalThis.fetch;
  readonly maxTokens?: number;
  readonly temperature?: number;
}

interface BuiltHostConfig {
  readonly bindings: Readonly<Record<string, CapabilityBinding<never, unknown>>>;
  readonly modelRouting: ModelRouting;
  readonly endpoints: Readonly<Record<string, Endpoint>>;
}

/** Builds fresh runtime instance options without constructing providers or invoking hooks. */
export function buildHostConfig(
  config: ValidatedHostConfig,
  codeBindings: Readonly<Record<string, CapabilityBinding<never, unknown>>> = {},
): BuiltHostConfig {
  assertValidatedHostConfig(config);
  const data = config.document;
  const hooks = config.hooks;
  for (const name of Object.keys(data.capabilities ?? {}))
    if (Object.hasOwn(codeBindings, name))
      throw new HostConfigError('invalid', pointer(['capabilities', name]));
  const bindings = Object.fromEntries(
    Object.entries(data.capabilities ?? {}).map(([name, capability]) => {
      const { headers, fetch, ...options } = capability;
      return [
        name,
        httpCapability(
          copyDocument({
            ...options,
            ...(headers === undefined ? {} : { headers: hooks.headers?.[headers] }),
            ...(fetch === undefined ? {} : { fetch: hooks.fetch?.[fetch] }),
          }) as HttpCapabilityOptions,
        ),
      ];
    }),
  );
  const providers = Object.fromEntries(
    Object.entries(data.models?.providers ?? {}).map(
      ([id, { endpoint: _endpoint, ...descriptor }]) => [id, copyDocument(descriptor)],
    ),
  );
  const endpoints = Object.fromEntries(
    Object.entries(data.models?.providers ?? {}).flatMap(([id, provider]) => {
      if (provider.endpoint === undefined) return [];
      const { fetch, ...endpoint } = provider.endpoint;
      return [
        [
          id,
          {
            ...endpoint,
            destination: provider.destination,
            ...(fetch === undefined ? {} : { fetch: hooks.fetch?.[fetch] }),
          },
        ],
      ];
    }),
  );
  const models = data.models;
  return {
    bindings: { ...codeBindings, ...bindings },
    modelRouting: copyDocument({
      providers,
      roles: copyDocument(models?.roles ?? {}),
      ...(models?.consent === undefined ? {} : { consent: hooks.consent?.[models.consent] }),
      ...(models?.getCredential === undefined
        ? {}
        : { getCredential: hooks.getCredential?.[models.getCredential] }),
      ...(models?.availability === undefined
        ? {}
        : { availability: hooks.availability?.[models.availability] }),
      ...(models?.download === undefined ? {} : { download: hooks.download?.[models.download] }),
    }) as ModelRouting,
    endpoints: copyDocument(endpoints) as Readonly<Record<string, Endpoint>>,
  };
}

/** Runtime-wide limits come from exactly one document; the host supplies appId and executors. */
export function buildRuntimeLimits(
  config: ValidatedHostConfig,
): Pick<RuntimeOptions, 'budgets' | 'dataPolicy' | 'urlAllowlist'> {
  assertValidatedHostConfig(config);
  return copyDocument(config.document.limits ?? {}) as Pick<
    RuntimeOptions,
    'budgets' | 'dataPolicy' | 'urlAllowlist'
  >;
}
