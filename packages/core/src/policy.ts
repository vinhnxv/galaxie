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

/** What a schema field declares for the data-label rules (ADR-0014). Schemas carry it through x-galaxie metadata. */
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

export const DESTINATIONS: readonly DestinationClass[] = Object.freeze([
  'in-browser',
  'user-device',
  'user-endpoint',
  'host-server',
  'third-party',
]);
export const DEFAULT_DATA_POLICY: Readonly<Record<DataLabel, DestinationAllowlist>> = Object.freeze(
  {
    public: Object.freeze({ allow: DESTINATIONS }),
    app: Object.freeze({
      allow: Object.freeze(DESTINATIONS.filter((value) => value !== 'third-party')),
    }),
    'private-user': Object.freeze({ allow: Object.freeze(['in-browser'] as const) }),
  },
);
export const DEFAULT_BUDGETS: BudgetLimits = Object.freeze({
  steps: 25,
  toolCalls: 50,
  wallClockMs: 300000,
  payloadBytes: 1048576,
  tokens: 100000,
  cost: 0,
  repairAttempts: 2,
  uiElements: 50,
});

export function galaxieField(annotation: FieldAnnotation): {
  readonly 'x-galaxie': FieldAnnotation;
} {
  return { 'x-galaxie': annotation };
}

/** Every sticky label must permit the final destination. Empty labels permit all destinations. */
export function labelsAllow(
  policy: Readonly<Record<DataLabel, DestinationAllowlist>>,
  labels: Iterable<DataLabel>,
  destination: DestinationClass,
): boolean {
  return [...labels].every((label) => policy[label].allow.includes(destination));
}

/** Text never enters spans when any current label is restricted to the browser alone. */
export function inBrowserOnly(
  policy: Readonly<Record<DataLabel, DestinationAllowlist>>,
  labels: Iterable<DataLabel>,
): boolean {
  return [...labels].some(
    (label) => policy[label].allow.length === 1 && policy[label].allow[0] === 'in-browser',
  );
}
