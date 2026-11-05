// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { CapabilityKind, CapabilityRequests } from './capabilities.js';
import type { AgentDefinition } from './definition.js';
import { GalaxieError } from './errors.js';
import type { Schema } from './schema.js';

export interface ManifestCapability {
  readonly kind: CapabilityKind;
  readonly input: string;
  readonly output: string;
}

/** Build-time description of a code-first definition, without host grants or credentials. */
export interface AgentManifest {
  readonly schemaVersion: '0.2';
  readonly id: string;
  readonly version: string;
  readonly executor: string;
  readonly entry: string;
  readonly inputSchema: string;
  readonly requiredCapabilities?: Readonly<Record<string, ManifestCapability>>;
  readonly optionalCapabilities?: Readonly<Record<string, ManifestCapability>>;
  readonly models?: AgentDefinition['models'];
  readonly ui?: AgentDefinition['ui'];
  readonly skills?: readonly string[];
}

function sorted<T>(record: Readonly<Record<string, T>>): [string, T][] {
  return Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function pathKey(path: string): string {
  if (
    typeof path !== 'string' ||
    !path.startsWith('./') ||
    /[\\:]/.test(path) ||
    [...path].some((character) => character.charCodeAt(0) < 32) ||
    path.split('/').includes('..')
  )
    throw new GalaxieError('invalid', 'The manifest path is invalid.');
  const key = path
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/');
  if (!key) throw new GalaxieError('invalid', 'The manifest path is invalid.');
  return key;
}

function validate(definition: AgentDefinition, entry: string): void {
  for (const value of [definition.id, definition.version, definition.executor]) {
    if (typeof value !== 'string' || value.trim().length === 0)
      throw new GalaxieError('invalid', 'The definition identity is invalid.');
  }
  const names = new Set<string>();
  for (const group of [definition.capabilities?.required, definition.capabilities?.optional]) {
    for (const name of Object.keys(group ?? {})) {
      if (
        !/^[^/\\:@]+@[0-9]+$/.test(name) ||
        [...name].some((character) => character.charCodeAt(0) < 32) ||
        names.has(name)
      )
        throw new GalaxieError('invalid', 'The capability name is invalid.');
      names.add(name);
    }
  }
  const paths = new Set<string>();
  for (const path of [entry, ...(definition.skills ?? [])]) {
    const key = pathKey(path);
    if (paths.has(key)) throw new GalaxieError('invalid', 'The manifest paths must be unique.');
    paths.add(key);
  }
}

function jsonSchema(schema: Schema): unknown {
  try {
    const standard = schema['~standard'] as unknown as {
      jsonSchema?: { input(options: { target: string }): unknown };
    };
    if (typeof standard.jsonSchema?.input === 'function')
      return standard.jsonSchema.input({ target: 'draft-2020-12' });
  } catch {}
  throw new GalaxieError('unsupported', 'The schema cannot be represented.');
}

/** Pure manifest and schema generation. Custom schema refinements remain runtime-only. */
export function createManifest(
  definition: AgentDefinition,
  options: { entry: string },
): { manifest: AgentManifest; schemas: Readonly<Record<string, unknown>> } {
  validate(definition, options.entry);
  const schemas: Record<string, unknown> = { './schemas/input.json': jsonSchema(definition.input) };
  const capabilities = (group: CapabilityRequests): Readonly<Record<string, ManifestCapability>> =>
    Object.fromEntries(
      sorted(group).map(([name, request]) => {
        const input = `./schemas/${name}.input.json`;
        const output = `./schemas/${name}.output.json`;
        schemas[input] = jsonSchema(request.input);
        schemas[output] = jsonSchema(request.output);
        return [name, { kind: request.kind, input, output }];
      }),
    );
  const manifest: AgentManifest = {
    schemaVersion: '0.2',
    id: definition.id,
    version: definition.version,
    executor: definition.executor,
    entry: options.entry,
    inputSchema: './schemas/input.json',
    ...(definition.capabilities?.required === undefined
      ? {}
      : {
          requiredCapabilities: capabilities(definition.capabilities.required),
        }),
    ...(definition.capabilities?.optional === undefined
      ? {}
      : {
          optionalCapabilities: capabilities(definition.capabilities.optional),
        }),
    ...(definition.models === undefined
      ? {}
      : {
          models: Object.fromEntries(sorted(definition.models)),
        }),
    ...(definition.ui === undefined ? {} : { ui: definition.ui }),
    ...(definition.skills === undefined ? {} : { skills: definition.skills }),
  };
  return {
    manifest,
    schemas: Object.fromEntries(sorted(schemas)),
  };
}
