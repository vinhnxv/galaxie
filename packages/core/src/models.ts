// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { DestinationAllowlist, DestinationClass, DestinationPreset } from './policy.js';

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

/** Host-chosen identifier for a provider/model pair (ADR-0006). */
export type ModelProviderId = string;

/** Per-token prices in the host's cost unit (brief §9.4, ADR-0006). */
export type ModelPricing =
  | 'unknown'
  | { readonly inputPerToken: number; readonly outputPerToken: number };

/** Host claims about a provider, validated before preparing an agent (ADR-0006). */
export interface ModelDescriptor {
  /** Final recipient, including when a proxy forwards the call (ADR-0006). */
  readonly destination: DestinationClass;
  /** Text only in M1 (brief §10.5). */
  readonly modality: 'text';
  /** Features supported by this provider (brief §10.5). */
  readonly features: readonly ModelFeature[];
  /** Supported BCP 47 language tags (brief §10.5). */
  readonly languages?: readonly string[];
  /** Prices used for reservations and settlement (ADR-0006). */
  readonly pricing: ModelPricing;
  /** Requires a per-call host credential (ADR-0006). */
  readonly credential?: boolean;
}

/** Ordered host policy for one declared role (ADR-0006). */
export interface ModelRoute extends DestinationAllowlist {
  /** Only these providers may serve the role (ADR-0006). */
  readonly providers: readonly ModelProviderId[];
  /** Per-call reservation, not a provider token cap (brief §9.4). */
  readonly maxTokens: number;
  /** Reservation required only when a listed provider has unknown pricing (ADR-0006). */
  readonly maxCost?: number;
  /** Maximum repair calls per routed structured invocation; defaults to zero. */
  readonly repairAttempts?: number;
}

/** Public notice of the provider and final destination used by a call (ADR-0006). */
export interface SelectedModelRoute {
  /** Host's provider identifier (ADR-0006). */
  readonly providerId: ModelProviderId;
  /** Final recipient of the call (ADR-0006). */
  readonly destination: DestinationClass;
}

/** Published selection, including a destination-class notice (ADR-0006). */
export interface PublishedModelRoute extends SelectedModelRoute {
  /** Instance-wide previous class, only when the destination changes (ADR-0006). */
  readonly changedFrom?: DestinationClass;
}

/** Validated readiness reported by the host without starting a download (ADR-0006). */
export type ModelAvailability =
  | { readonly status: 'available' }
  | { readonly status: 'unavailable' }
  | { readonly status: 'downloadable'; readonly bytes?: number; readonly siteStorage: boolean };

/** A readiness probe carries no model input (ADR-0006). */
export interface ModelAvailabilityRequest {
  readonly role: ModelRoleName;
  readonly providerId: ModelProviderId;
  readonly signal: AbortSignal;
}

/** The host obtains consent and completes the download before returning true (ADR-0006). */
export interface ModelDownloadRequest extends ModelAvailabilityRequest {
  readonly bytes?: number;
  /** Request site persistence after acceptance, before downloading (ADR-0006). */
  readonly persist?: () => Promise<boolean>;
}

/** One instance-wide consent decision for a role and destination class (ADR-0006). */
export interface ModelConsentRequest {
  /** Role asking to send data (ADR-0006). */
  readonly role: ModelRoleName;
  /** Class whose providers this answer covers (ADR-0006). */
  readonly destination: DestinationClass;
  /** All providers in that class, in route order (ADR-0006). */
  readonly providers: readonly ModelProviderId[];
  /** Most recently dispatched route for the role (ADR-0006). */
  readonly previous?: SelectedModelRoute;
  /** Aborted when no call still awaits this decision (brief §8.3). */
  readonly signal: AbortSignal;
}

/** A credential request carries no messages or configuration (ADR-0006). */
export interface ModelCredentialRequest {
  /** Role making the call (ADR-0006). */
  readonly role: ModelRoleName;
  /** Provider receiving the credential (ADR-0006). */
  readonly providerId: ModelProviderId;
}

/** Per-instance host routing configuration (ADR-0006). */
export interface ModelRouting {
  /** Descriptors keyed by host provider ID (ADR-0006). */
  readonly providers: Readonly<Record<ModelProviderId, ModelDescriptor>>;
  /** Policy for every role in the definition (ADR-0006). */
  readonly roles: Readonly<Record<ModelRoleName, ModelRoute>>;
  /** Approval before any non-browser destination is used (ADR-0006). */
  readonly consent?: (request: ModelConsentRequest) => boolean | Promise<boolean>;
  /** Probe readiness on each call; absence means available (ADR-0006). */
  readonly availability?: (
    request: ModelAvailabilityRequest,
  ) => ModelAvailability | Promise<ModelAvailability>;
  /** Shared download decision; without it, downloadable providers are unavailable (ADR-0006). */
  readonly download?: (request: ModelDownloadRequest) => boolean | Promise<boolean>;
  /** Per-call credential; never persisted by galaxie (ADR-0006). */
  readonly getCredential?: (request: ModelCredentialRequest) => string | Promise<string>;
}

/** Provider-reported usage; the router validates both counts (brief §9.4). */
export interface ModelUsage {
  /** Input tokens charged after dispatch (brief §9.4). */
  readonly inputTokens: number;
  /** Output tokens charged after dispatch (brief §9.4). */
  readonly outputTokens: number;
}

/** Host policy for model-generated text, including accumulated tool arguments. */
export interface OutputSafetyCheck {
  readonly text: string;
  readonly final: boolean;
  readonly role: ModelRoleName;
  readonly destination: DestinationClass;
  readonly signal: AbortSignal;
}

export type OutputSafetyVerdict = 'allow' | 'block';
export type OutputSafetyHook = (
  check: OutputSafetyCheck,
) => OutputSafetyVerdict | Promise<OutputSafetyVerdict>;
export type OutputSafetyOutcome = 'allowed' | 'blocked' | 'failed' | 'unset';

/** One reserved call; only this lease carries the credential (ADR-0006). */
export interface ModelCall extends SelectedModelRoute {
  /** Ephemeral value for this call's provider factory (ADR-0006). */
  readonly credential?: string;
  /** Last check outcome, or unset when no hook is configured. */
  readonly outputSafetyOutcome: OutputSafetyOutcome | undefined;
  /** Must pass before generated text reaches an executor or a stream consumer. */
  checkOutput(text: string, options: { readonly final: boolean }): Promise<void>;
  /** Settles once with valid usage, or the reservation when absent (ADR-0006). */
  end(usage?: ModelUsage): void;
  /** Settles once at the reservation on failure or abandonment (ADR-0006). */
  fail(): void;
}

/** Framework-neutral, run-bound model policy boundary (ADR-0006, ADR-0017). */
export interface ModelPort {
  /** Selects, obtains consent and reserves before dispatch (ADR-0006). */
  begin(
    role: ModelRoleName,
    options?: {
      readonly signal?: AbortSignal;
      readonly requires?: readonly ModelFeature[];
      /** One-based repair index within a structured invocation. */
      readonly repairAttempt?: number;
    },
  ): Promise<ModelCall>;
}

/** Implementation requirements disclosed to an executor at prepare (ADR-0006). */
export interface ModelPreparation {
  /** Routed roles; omitted configuration means no roles (ADR-0006). */
  readonly roles: readonly ModelRoleName[];
  /** Routed provider IDs and whether a factory is required (ADR-0006). */
  readonly providers: Readonly<Record<ModelProviderId, { readonly credential: boolean }>>;
}
