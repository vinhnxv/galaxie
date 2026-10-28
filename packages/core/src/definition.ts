// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type {
  CapabilityBinding,
  CapabilityName,
  CapabilityRequest,
  CapabilityRequests,
} from './capabilities.js';
import type { AgentId } from './ids.js';
import type { UiRequirements } from './interactions.js';
import type { ModelRoleName, ModelRoleRequirements } from './models.js';
import type { Infer, InferInput, Schema } from './schema.js';

/** A code-first agent definition. The build generates the manifest from it (brief §13.2, ADR-0008). */
export interface AgentDefinition {
  readonly id: AgentId;
  /** The package version (semver). */
  readonly version: string;
  /** The executor ID, for example `langgraph-js`. */
  readonly executor: string;
  /** The schema of the run input. */
  readonly input: Schema;
  readonly capabilities?: {
    readonly required?: CapabilityRequests;
    readonly optional?: CapabilityRequests;
  };
  readonly models?: { readonly [role: ModelRoleName]: ModelRoleRequirements };
  readonly ui?: UiRequirements;
  /** Skill files bundled with the package (brief §13.4). */
  readonly skills?: readonly string[];
}

/**
 * Maps every requested capability whose name lacks an `@<version>` suffix to `never` (ADR-0008).
 * The `AgentDefinition` constraint alone lets such a name through as an extra property.
 */
type VersionedRequests<R> = {
  readonly [Name in keyof R]: Name extends CapabilityName ? R[Name] : never;
};

type VersionedCapabilities<D> = D extends { readonly capabilities: infer C }
  ? { readonly capabilities: { readonly [Group in keyof C]: VersionedRequests<C[Group]> } }
  : unknown;

/** Declares an agent definition and keeps its literal types, so host bindings can be checked against it. */
export function defineAgentDefinition<const D extends AgentDefinition>(
  definition: D & VersionedCapabilities<D>,
): D {
  return definition;
}

/** The run input of a definition, after validation. */
export type InputOf<D extends AgentDefinition> = Infer<D['input']>;

type RequiredRequests<D> = D extends { readonly capabilities: { readonly required: infer R } }
  ? R
  : Record<never, never>;

type OptionalRequests<D> = D extends { readonly capabilities: { readonly optional: infer R } }
  ? R
  : Record<never, never>;

type BindingFor<R> =
  R extends CapabilityRequest<infer Input extends Schema, infer Output extends Schema>
    ? CapabilityBinding<Infer<Input>, InferInput<Output>>
    : never;

/**
 * The host bindings a definition needs: one for every required capability, and optional ones as the
 * host chooses. A missing or mistyped binding fails to compile (ADR-0008).
 */
export type BindingsFor<D extends AgentDefinition> = {
  readonly [Name in keyof RequiredRequests<D>]: BindingFor<RequiredRequests<D>[Name]>;
} & {
  readonly [Name in keyof OptionalRequests<D>]?: BindingFor<OptionalRequests<D>[Name]>;
};
