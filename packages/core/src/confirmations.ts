// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { CapabilityName } from './capabilities.js';
import { type ErrorCode, GalaxieError, toErrorInfo } from './errors.js';
import type { ConfirmationId, EffectId, PrincipalScope, RunId } from './ids.js';
import { copyRecoveryJson, type RecoveryJson } from './recovery.js';
import type { DiagnosticEvent } from './runtime.js';

export type { ConfirmationId } from './ids.js';

/** Host-owned rendering coverage and invalidation policy. Approvals never leave page memory. */
export interface ConfirmationOptions {
  readonly capabilities: readonly CapabilityName[];
  readonly policyRevision: () => string;
  readonly expiresInMs?: number;
  readonly signals?: readonly AbortSignal[];
}

/** Host-only snapshot data; never pass this entry to an agent component or trace exporter. */
export interface PendingConfirmation {
  readonly id: ConfirmationId;
  readonly capability: CapabilityName;
  readonly arguments: unknown;
  readonly expiresAt: number;
}

export interface ConfirmationReceipt {
  readonly status: 'approved' | 'declined' | 'stale';
}

function failure(code: ErrorCode): GalaxieError {
  return new GalaxieError(code, toErrorInfo(code).message);
}

/** Shared with the write journal so approvals and recovery bind the same canonical JSON. */
export async function digest(value: RecoveryJson): Promise<string> {
  const canonical = (item: RecoveryJson): string => {
    if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`;
    if (item !== null && typeof item === 'object')
      return `{${Object.keys(item)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(item[key] as RecoveryJson)}`)
        .join(',')}}`;
    return JSON.stringify(item);
  };
  const bytes = new TextEncoder().encode(canonical(value));
  return [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function approvedCopy(value: unknown): RecoveryJson {
  try {
    const copy = copyRecoveryJson(value);
    const freeze = (item: RecoveryJson): void => {
      if (item !== null && typeof item === 'object') {
        for (const child of Object.values(item)) freeze(child);
        Object.freeze(item);
      }
    };
    freeze(copy);
    return copy;
  } catch {
    throw failure('invalid');
  }
}

export interface Approval {
  readonly value: RecoveryJson;
  readonly effectId: EffectId;
  check(): Promise<void>;
  release(): void;
}

interface RecordEntry {
  readonly pending: PendingConfirmation;
  readonly runId: RunId;
  respond(decision: 'approve' | 'decline'): ConfirmationReceipt;
  end(code: ErrorCode, diagnostic?: DiagnosticEvent['kind'], notify?: boolean): void;
}

/** Per-instance single-use approvals, separate from executor events and interaction dispatch. */
export class ConfirmationGate {
  readonly capabilities: readonly CapabilityName[];
  readonly #options: ConfirmationOptions;
  readonly #principal: PrincipalScope;
  readonly #changed: () => void;
  readonly #report: (event: Omit<DiagnosticEvent, 'instanceId'>) => void;
  readonly #open = new Map<ConfirmationId, RecordEntry>();
  readonly #active = new Set<RecordEntry>();

  constructor(
    options: ConfirmationOptions,
    principal: PrincipalScope,
    changed: () => void,
    report: (event: Omit<DiagnosticEvent, 'instanceId'>) => void,
  ) {
    const expires = options?.expiresInMs === undefined ? 120_000 : options.expiresInMs;
    if (
      options === null ||
      !Array.isArray(options.capabilities) ||
      !options.capabilities.every((name: unknown) => typeof name === 'string') ||
      typeof options.policyRevision !== 'function' ||
      !Number.isSafeInteger(expires) ||
      expires < 1_000 ||
      expires > 600_000 ||
      (options.signals !== undefined &&
        (!Array.isArray(options.signals) ||
          !options.signals.every((signal: unknown) => signal instanceof AbortSignal)))
    )
      throw failure('invalid');
    this.capabilities = Object.freeze([...options.capabilities]) as readonly CapabilityName[];
    this.#options = Object.freeze({
      ...options,
      capabilities: this.capabilities,
      expiresInMs: expires,
      signals: Object.freeze([...(options.signals ?? [])]),
    });
    this.#principal = principal;
    this.#changed = changed;
    this.#report = report;
  }

  get pending(): readonly PendingConfirmation[] | undefined {
    return this.#open.size === 0
      ? undefined
      : Object.freeze([...this.#open.values()].map((entry) => entry.pending));
  }

  #revision(): string {
    try {
      const revision = this.#options.policyRevision();
      if (typeof revision === 'string' && revision.length > 0 && revision.length <= 128)
        return revision;
    } catch {
      /* Host policy text is never diagnostic evidence. */
    }
    throw failure('unavailable');
  }

  respond(id: ConfirmationId, decision: 'approve' | 'decline'): ConfirmationReceipt {
    try {
      if (typeof id !== 'string' || (decision !== 'approve' && decision !== 'decline'))
        return { status: 'stale' };
      return this.#open.get(id)?.respond(decision) ?? { status: 'stale' };
    } catch {
      return { status: 'stale' };
    }
  }

  endRun(runId: RunId, disposed: boolean): void {
    for (const entry of this.#active)
      if (entry.runId === runId)
        entry.end('cancelled', disposed ? 'confirmation_invalidated' : undefined, false);
  }

  async request(
    capability: CapabilityName,
    value: RecoveryJson,
    effectId: EffectId,
    runId: RunId,
    signal: AbortSignal,
    active: () => boolean,
    invalidate: (code: ErrorCode) => void,
  ): Promise<Approval> {
    const inputDigest = await digest(value);
    const revision = this.#revision();
    const principal = this.#principal;
    if (signal.aborted || !active()) throw failure('cancelled');
    if (this.#options.signals?.some((signal) => signal.aborted)) {
      this.#report({ kind: 'confirmation_invalidated', runId });
      throw failure('denied');
    }
    const pending = Object.freeze({
      id: globalThis.crypto.randomUUID() as ConfirmationId,
      capability,
      arguments: value,
      expiresAt: Date.now() + (this.#options.expiresInMs as number),
    });
    const { promise, resolve, reject } = Promise.withResolvers<Approval>();
    let ended = false;
    let approved = false;
    let error: GalaxieError | undefined;
    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      for (const hostSignal of this.#options.signals ?? [])
        hostSignal.removeEventListener('abort', invalidated);
      this.#active.delete(entry);
    };
    const close = (notify = true): void => {
      if (this.#open.delete(pending.id) && notify) this.#changed();
    };
    const end = (code: ErrorCode, diagnostic?: DiagnosticEvent['kind'], notify = true): void => {
      if (ended) return;
      ended = true;
      error = failure(code);
      cleanup();
      close(notify);
      if (diagnostic !== undefined) this.#report({ kind: diagnostic, runId });
      reject(error);
      // Once approved, the request promise has settled; wake a queued dispatch as well.
      if (approved) invalidate(code);
    };
    const valid = (): boolean => {
      if (ended) return false;
      if (signal.aborted || !active()) end('cancelled');
      else if (this.#options.signals?.some((signal) => signal.aborted))
        end('denied', 'confirmation_invalidated');
      else if (Date.now() >= pending.expiresAt) end('denied', 'confirmation_expired');
      else {
        try {
          if (principal !== this.#principal || this.#revision() !== revision)
            end('denied', 'confirmation_invalidated');
        } catch {
          end('unavailable');
        }
      }
      return !ended;
    };
    const approval: Approval = {
      value,
      effectId,
      check: async () => {
        const currentDigest = await digest(value);
        if (!valid()) throw error ?? failure('denied');
        if (currentDigest !== inputDigest) {
          end('denied', 'confirmation_invalidated');
          throw failure('denied');
        }
      },
      release: () => {
        ended = true;
        cleanup();
        close();
      },
    };
    const entry: RecordEntry = {
      pending,
      runId,
      end,
      respond: (decision) => {
        if (approved || !valid()) return { status: 'stale' };
        if (decision === 'decline') {
          end('denied', 'confirmation_declined');
          return { status: 'declined' };
        }
        approved = true;
        close();
        resolve(approval);
        return { status: 'approved' };
      },
    };
    const aborted = (): void => end('cancelled');
    const invalidated = (): void => end('denied', 'confirmation_invalidated');
    const timer = setTimeout(
      () => end('denied', 'confirmation_expired'),
      pending.expiresAt - Date.now(),
    );
    this.#active.add(entry);
    this.#open.set(pending.id, entry);
    signal.addEventListener('abort', aborted, { once: true });
    for (const hostSignal of this.#options.signals ?? [])
      hostSignal.addEventListener('abort', invalidated, { once: true });
    this.#report({ kind: 'confirmation_requested', runId });
    this.#changed();
    return promise;
  }
}
