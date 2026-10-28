// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { channel } from 'node:diagnostics_channel';
import { trace } from '@opentelemetry/api';
import { expect, test } from 'vitest';
import { collect, deferred, flush, ready } from './fake-executor.js';
import { recordNetwork } from './network-recorder.js';

test('a full lifecycle without an SDK makes no network request', async () => {
  trace.disable();
  const recorder = recordNetwork();
  const names = ['http.client.request.start', 'net.client.socket', 'undici:request:create'];
  const observed: string[] = [];
  const subscriptions = names.map((name) => {
    const subscribed = channel(name);
    const listener = (): void => {
      observed.push(name);
    };
    subscribed.subscribe(listener);
    return { subscribed, listener };
  });
  const latch = deferred<void>();
  try {
    await recorder.selfTest();
    for (const { subscribed } of subscriptions) subscribed.publish({});
    expect(observed).toEqual(names);
    observed.length = 0;
    const { runtime, instance } = await ready([
      [{ type: 'output', output: 'done' }],
      [{ throw: new Error('secret') }],
      [{ wait: latch.promise }],
    ]);
    try {
      for (const status of ['succeeded', 'failed']) {
        const { runId } = await instance.start('input');
        await collect(instance.events(runId));
        expect(instance.getSnapshot().run?.status).toBe(status);
      }
      const { runId } = await instance.start('input');
      await flush();
      await instance.cancel(runId);
      latch.resolve();
      await runtime.dispose();
      expect(recorder.calls).toEqual([]);
      expect(observed).toEqual([]);
    } finally {
      latch.resolve();
      await runtime.dispose();
    }
  } finally {
    recorder.restore();
    for (const { subscribed, listener } of subscriptions) subscribed.unsubscribe(listener);
    trace.disable();
  }
});

test('network recorder self-tests preserve requests observed during initialization', async () => {
  const recorder = recordNetwork();
  try {
    await recorder.selfTest();
    await fetch('https://initialization-probe.invalid/');
    await expect(recorder.selfTest()).rejects.toThrow(
      'Network requests were observed before recorder self-test.',
    );
    expect(recorder.calls).toEqual(['fetch']);
  } finally {
    recorder.restore();
  }
});
