// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { GalaxieError, toErrorInfo } from './errors.js';
import type { EffectId, InteractionId, SessionId } from './ids.js';

/** Structured-clone-safe JSON; recovery data stays on the principal's device. */
export type RecoveryJson =
  | null
  | boolean
  | number
  | string
  | RecoveryJson[]
  | { [key: string]: RecoveryJson };

/** An answer and its durable receipt. Returned identifiers deliberately carry no core brand. */
export interface RecoverySubmission {
  readonly interactionId: string;
  readonly action: string;
  readonly payload: RecoveryJson;
  readonly status: 'accepted' | 'consumed';
}

/** The input digest detects a changed call order during replay. */
export type EffectRecord =
  | {
      readonly status: 'planned' | 'dispatched' | 'failed' | 'outcome_unknown';
      readonly inputDigest: string;
    }
  | { readonly status: 'succeeded'; readonly inputDigest: string; readonly output: RecoveryJson };

/**
 * Host-provided durable recovery, scoped to the same app and principal as the checkpointer.
 * Every write resolves only after durable commit. Answers and capability outputs are private
 * principal data, as private as checkpoints, and must stay on-device.
 */
export interface RecoveryStore {
  /** Atomic insert-if-absent by session and interaction, including consumed receipts. */
  acceptSubmission(
    sessionId: SessionId,
    entry: {
      readonly interactionId: InteractionId;
      readonly action: string;
      readonly payload: RecoveryJson;
    },
  ): Promise<'accepted' | 'duplicate'>;
  consumeSubmission(sessionId: SessionId, interactionId: InteractionId): Promise<void>;
  submissions(sessionId: SessionId): Promise<readonly RecoverySubmission[]>;
  effect(sessionId: SessionId, effectId: EffectId): Promise<EffectRecord | undefined>;
  recordEffect(sessionId: SessionId, effectId: EffectId, record: EffectRecord): Promise<void>;
}

function corrupt(): never {
  throw new GalaxieError('unrecoverable', toErrorInfo('unrecoverable').message);
}

function json(value: unknown, ancestors: Set<object>): value is RecoveryJson {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (
    typeof value !== 'object' ||
    (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)
  )
    return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? Array.from(value).every((item) => json(item, ancestors))
    : Reflect.ownKeys(value).every((key) => {
        const field = Object.getOwnPropertyDescriptor(value, key);
        return (
          typeof key === 'string' &&
          field?.enumerable === true &&
          'value' in field &&
          json(field.value, ancestors)
        );
      });
  ancestors.delete(value);
  return valid;
}

/** Validate before trusting a store record or passing a value to a store. */
export function copyRecoveryJson(value: unknown): RecoveryJson {
  try {
    if (json(value, new Set())) return JSON.parse(JSON.stringify(value)) as RecoveryJson;
  } catch {
    // Stored content and validation failures never become error text or causes.
  }
  return corrupt();
}

export function validateSubmissions(
  value: unknown,
): readonly (RecoverySubmission & { readonly interactionId: InteractionId })[] {
  const copy = copyRecoveryJson(value);
  if (!Array.isArray(copy)) return corrupt();
  const ids = new Set<string>();
  return copy.map((entry) => {
    if (
      entry === null ||
      Array.isArray(entry) ||
      typeof entry !== 'object' ||
      Object.keys(entry).length !== 4 ||
      typeof entry['interactionId'] !== 'string' ||
      entry['interactionId'].length === 0 ||
      typeof entry['action'] !== 'string' ||
      entry['action'].length === 0 ||
      !Object.hasOwn(entry, 'payload') ||
      (entry['status'] !== 'accepted' && entry['status'] !== 'consumed') ||
      ids.has(entry['interactionId'])
    )
      return corrupt();
    ids.add(entry['interactionId']);
    return entry as unknown as RecoverySubmission & { readonly interactionId: InteractionId };
  });
}

export function validateEffectRecord(value: unknown): EffectRecord | undefined {
  if (value === undefined) return undefined;
  const copy = copyRecoveryJson(value);
  if (
    copy === null ||
    Array.isArray(copy) ||
    typeof copy !== 'object' ||
    typeof copy['inputDigest'] !== 'string' ||
    !/^[0-9a-f]{64}$/.test(copy['inputDigest'])
  )
    return corrupt();
  if (
    copy['status'] === 'succeeded' &&
    Object.keys(copy).length === 3 &&
    Object.hasOwn(copy, 'output')
  )
    return copy as unknown as EffectRecord;
  if (
    ['planned', 'dispatched', 'failed', 'outcome_unknown'].includes(copy['status'] as string) &&
    Object.keys(copy).length === 2
  )
    return copy as unknown as EffectRecord;
  return corrupt();
}
