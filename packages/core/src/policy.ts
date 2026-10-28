// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The final recipient of the data in a model or capability call, not the first hop (brief §3.1,
 * ADR-0006). A host proxy that forwards to an external provider is `third-party`.
 */
export type DestinationClass =
  | 'in-browser'
  | 'user-device'
  | 'user-endpoint'
  | 'host-server'
  | 'third-party';

/** Role presets: `local-only` is `in-browser` only; `remote-allowed` is what the host configures (brief §3.1). */
export type DestinationPreset = 'local-only' | 'remote-allowed';

/** An allowlist of destination classes (brief §14.2). */
export interface DestinationAllowlist {
  readonly allow: readonly DestinationClass[];
}

/** Labels on schema fields. A run keeps every label it has read until the run ends (ADR-0014). */
export type DataLabel = 'public' | 'app' | 'private-user';

/** The declared shape of a string field in a capability input. Only `freeText` can carry a sentence (ADR-0014). */
export type ArgumentShape = 'id' | 'enum' | 'pattern' | 'freeText';

/** What a schema field declares for the data-label rules (ADR-0014). How a schema carries it is settled in M1. */
export interface FieldAnnotation {
  readonly label?: DataLabel;
  readonly shape?: ArgumentShape;
}

/** The destination classes each data label may reach. Per-role policy can narrow this, never widen it (ADR-0014). */
export type DataPolicy = { readonly [Label in DataLabel]?: DestinationAllowlist };

/** Run budgets (brief §9.4). Every limit is finite; reaching one gives a `budget_exceeded` error. */
export interface BudgetLimits {
  readonly steps: number;
  readonly tokens: number;
  /** Money spent on remote providers, in the unit the host uses for provider prices. */
  readonly cost: number;
  readonly repairAttempts: number;
  readonly toolCalls: number;
  readonly wallClockMs: number;
  readonly payloadBytes: number;
  readonly uiElements: number;
}
