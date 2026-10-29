// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { deadlineTimer } from './budgets.js';
import { type ErrorCode, GalaxieError, toErrorInfo } from './errors.js';

export type OwnershipLostReason = 'released' | 'handover' | 'stolen' | 'stale';
export interface Ownership {
  readonly signal: AbortSignal;
  readonly lostReason: OwnershipLostReason | undefined;
  release(): Promise<void>;
  verify(): Promise<boolean>;
}
export interface OwnershipOptions {
  readonly appId: string;
  readonly takeover?: boolean;
  readonly handoverTimeoutMs?: number;
  readonly onHandoverRequest: () => Promise<void> | void;
  readonly fence?: { claim(): Promise<void>; current(): Promise<boolean> };
}
export type OwnershipResult =
  | { readonly status: 'owner'; readonly ownership: Ownership }
  | { readonly status: 'busy' };

function failure(code: ErrorCode): GalaxieError {
  return new GalaxieError(code, toErrorInfo(code).message);
}
function handover(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.keys(value).length === 2 &&
    Object.hasOwn(value, 'v') &&
    Object.hasOwn(value, 'type') &&
    'v' in value &&
    value.v === 1 &&
    'type' in value &&
    value.type === 'handover'
  );
}

/** Hold one app's Web Lock until release or loss; the host composes runtime disposal and fencing. */
export async function acquireOwnership(options: OwnershipOptions): Promise<OwnershipResult> {
  if (
    typeof options !== 'object' ||
    options === null ||
    typeof options.appId !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(options.appId) ||
    (options.takeover !== undefined && typeof options.takeover !== 'boolean') ||
    (options.handoverTimeoutMs !== undefined &&
      (!Number.isFinite(options.handoverTimeoutMs) || options.handoverTimeoutMs <= 0)) ||
    typeof options.onHandoverRequest !== 'function' ||
    (options.fence !== undefined &&
      (options.fence === null ||
        typeof options.fence.claim !== 'function' ||
        typeof options.fence.current !== 'function'))
  )
    throw failure('invalid');
  const locks = globalThis.navigator?.locks;
  if (typeof locks?.request !== 'function' || typeof globalThis.BroadcastChannel !== 'function')
    throw failure('unsupported');
  const name = `galaxie:${options.appId}:runtime`;
  let channel: BroadcastChannel;
  try {
    channel = new BroadcastChannel(name);
  } catch {
    throw failure('unavailable');
  }

  const hold = async (lockOptions: LockOptions): Promise<Ownership | undefined> => {
    const acquired = Promise.withResolvers<Ownership | undefined>();
    const released = Promise.withResolvers<void>();
    const controller = new AbortController();
    let reason: OwnershipLostReason | undefined;
    let settled = false;
    let granted = false;
    let requested = false;
    const lose = (next: OwnershipLostReason): void => {
      if (reason !== undefined) return;
      reason = next;
      globalThis.removeEventListener?.('pageshow', pageshow);
      channel.close();
      released.resolve();
      controller.abort(next);
    };
    const verify = async (): Promise<boolean> => {
      if (reason !== undefined) return false;
      let current = !settled;
      try {
        if (current && options.fence !== undefined) current = await options.fence.current();
      } catch {
        current = false;
      }
      if (reason !== undefined) return false;
      if (!current || settled) {
        lose('stale');
        return false;
      }
      return true;
    };
    const pageshow = (event: Event): void => {
      if ('persisted' in event && event.persisted === true) void verify();
    };
    let holding: Promise<unknown>;
    try {
      holding = locks.request(name, lockOptions, async (lock) => {
        if (lock === null) {
          acquired.resolve(undefined);
          return;
        }
        granted = true;
        channel.onmessage = (event: MessageEvent<unknown>) => {
          if (reason !== undefined || requested || !handover(event.data)) return;
          requested = true;
          void Promise.resolve()
            .then(() => options.onHandoverRequest())
            .catch(() => {})
            .then(() => lose('handover'));
        };
        try {
          await options.fence?.claim();
          if (reason !== undefined) throw failure('unavailable');
          globalThis.addEventListener?.('pageshow', pageshow);
          acquired.resolve({
            signal: controller.signal,
            get lostReason() {
              return reason;
            },
            async release() {
              lose('released');
              await holding.catch(() => {});
            },
            verify,
          });
          await released.promise;
        } catch {
          lose('released');
          acquired.reject(failure('unavailable'));
        }
      });
    } catch (error) {
      acquired.reject(error);
      holding = Promise.resolve();
    }
    void holding.then(
      () => {
        settled = true;
      },
      (error: unknown) => {
        settled = true;
        if (granted) lose('stolen');
        acquired.reject(error);
      },
    );
    return acquired.promise;
  };
  try {
    let ownership = await hold({ ifAvailable: true });
    if (ownership !== undefined) return { status: 'owner', ownership };
    if (options.takeover !== true) {
      channel.close();
      return { status: 'busy' };
    }
    channel.postMessage({ v: 1, type: 'handover' });
    const timeout = new AbortController();
    const clear = deadlineTimer(options.handoverTimeoutMs ?? 5000, () => timeout.abort());
    try {
      ownership = await hold({ signal: timeout.signal });
    } catch {
      if (!timeout.signal.aborted) throw failure('unavailable');
    } finally {
      clear();
    }
    if (ownership === undefined) ownership = await hold({ steal: true });
    if (ownership === undefined) throw failure('unavailable');
    return { status: 'owner', ownership };
  } catch {
    channel.close();
    throw failure('unavailable');
  }
}
