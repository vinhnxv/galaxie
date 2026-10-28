// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { DestinationAllowlist, DestinationPreset } from './policy.js';

/** A model role an agent declares, for example `quiz.generate` (brief §10.3). */
export type ModelRoleName = string;

/** Features a role can require (brief §10.5). A provider claims a feature only when a test covers it. */
export type ModelFeature = 'streaming' | 'structured-output' | 'tool-calling' | 'cancellation';

/** What a role needs (brief §10.3, §13.2). The host maps each role to an ordered list of providers. */
export interface ModelRoleRequirements {
  /** Text only in the MVP; voice comes later (brief §4.4). */
  readonly modality: 'text';
  readonly requires?: readonly ModelFeature[];
  /** BCP 47 tags of the languages the role reads and writes, for example `en` and `vi`. */
  readonly languages?: readonly string[];
  /** A request; the host decides the policy (brief §13.2). */
  readonly defaultPolicy?: DestinationPreset;
}

/** The destination classes each model role may use (ADR-0006). Data labels can only narrow them (ADR-0014). */
export type ModelPolicy = { readonly [role: ModelRoleName]: DestinationAllowlist };
