// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { channel } from 'node:diagnostics_channel';
import type { NetworkRecorder } from '../../../packages/core/test/network-recorder.js';

/** Node-only transport observations; the Chromium lane never imports this module. */
export function recordNodeNetwork(): NetworkRecorder {
  const calls: string[] = [];
  const subscriptions = [
    'http.client.request.start',
    'net.client.socket',
    'undici:request:create',
  ].map((name) => {
    const subscribed = channel(name);
    const listener = (): void => {
      calls.push(name);
    };
    subscribed.subscribe(listener);
    return { subscribed, listener };
  });
  return {
    calls,
    async selfTest(): Promise<void> {
      if (calls.length !== 0)
        throw new Error('Node network requests were observed before recorder self-test.');
      for (const { subscribed } of subscriptions) subscribed.publish({});
      if (calls.length !== subscriptions.length || new Set(calls).size !== subscriptions.length)
        throw new Error('A Node network recorder did not fire exactly once.');
      calls.length = 0;
    },
    reset(): void {
      calls.length = 0;
    },
    restore(): void {
      for (const { subscribed, listener } of subscriptions) subscribed.unsubscribe(listener);
    },
  };
}
