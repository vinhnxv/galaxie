// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import { waitForAbort } from './support/abort-signal.js';

test('an already-aborted signal resolves immediately', async () => {
  const signal = AbortSignal.abort('why');
  await waitForAbort(signal);
  expect(signal.reason).toBe('why');
});

test('a pending wait resolves only after the signal aborts', async () => {
  const controller = new AbortController();
  let resolved = false;
  const waiting = waitForAbort(controller.signal).then(() => {
    resolved = true;
  });
  await Promise.resolve();
  expect(resolved).toBe(false);
  controller.abort('stale');
  await waiting;
  expect(resolved).toBe(true);
  expect(controller.signal.reason).toBe('stale');
});

test('an Error abort reason does not reject the wait', async () => {
  const controller = new AbortController();
  const waiting = waitForAbort(controller.signal);
  controller.abort(new Error('The owner was lost.'));
  await expect(waiting).resolves.toBeUndefined();
});
