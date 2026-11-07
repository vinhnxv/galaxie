// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { GalaxieError, toErrorInfo } from './errors.js';
import { isValidScope } from './ids.js';

export interface InvalidationOptions {
  readonly appId: string;
  readonly principalScope: string;
}
export interface InvalidationWatcher {
  readonly signal: AbortSignal;
  announce(): void;
  close(): void;
}

/**
 * Watch same-origin logout notices for trusted app/principal IDs (1–128 letters, digits, . _ : -).
 * Invalid IDs throw `invalid`; missing BroadcastChannel throws `unsupported`.
 *
 * After the host's principal wipe commits, announce on `galaxie:<appId>:invalidation` with
 * `{ v: 1, type: 'invalidated', principalScope }`. Announcing and valid matching peer notices
 * abort signal with reason `'invalidated'`; other principals and malformed notices are ignored.
 * The host disables input, clears its own session/tokens, disposes and releases ownership on abort.
 * Delivery failure is caught by the next generation-checked write or persisted pageshow check.
 * Pass this signal through CreateOptions.confirmations.signals to invalidate approvals promptly.
 * The host must still dispose the instance. Already-sent remote requests may complete.
 *
 * Close idempotently on page teardown. A closed watcher receives and announces nothing.
 */
export function watchInvalidation(options: InvalidationOptions): InvalidationWatcher {
  if (
    typeof options !== 'object' ||
    options === null ||
    ![options.appId, options.principalScope].every(isValidScope)
  )
    throw new GalaxieError('invalid', toErrorInfo('invalid').message);
  if (typeof globalThis.BroadcastChannel !== 'function')
    throw new GalaxieError('unsupported', toErrorInfo('unsupported').message);
  let channel: BroadcastChannel;
  try {
    channel = new BroadcastChannel(`galaxie:${options.appId}:invalidation`);
  } catch {
    throw new GalaxieError('unavailable', toErrorInfo('unavailable').message);
  }
  const principalScope = options.principalScope;
  const controller = new AbortController();
  let closed = false;
  channel.onmessage = ({ data }: MessageEvent<unknown>) => {
    if (
      !closed &&
      typeof data === 'object' &&
      data !== null &&
      Object.keys(data).length === 3 &&
      Object.getOwnPropertyDescriptor(data, 'v')?.value === 1 &&
      Object.getOwnPropertyDescriptor(data, 'type')?.value === 'invalidated' &&
      Object.getOwnPropertyDescriptor(data, 'principalScope')?.value === principalScope
    )
      controller.abort('invalidated');
  };
  return {
    signal: controller.signal,
    announce() {
      if (closed) return;
      try {
        channel.postMessage({ v: 1, type: 'invalidated', principalScope });
      } catch {}
      controller.abort('invalidated');
    },
    close() {
      if (closed) return;
      closed = true;
      channel.onmessage = null;
      channel.close();
    },
  };
}
