// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import { createNotifier, waitForState } from './support/state-wait.js';

test('an assertion that already holds resolves and unsubscribes immediately', async () => {
  const { notify, subscribe } = createNotifier();
  let checks = 0;
  await waitForState(subscribe, () => {
    checks += 1;
    expect(true).toBe(true);
  });
  notify();
  expect(checks).toBe(1);
});

test('an assertion stays pending until notified of matching state, then unsubscribes', async () => {
  const { notify, subscribe } = createNotifier();
  let ready = false;
  let resolved = false;
  let checks = 0;
  const waiting = waitForState(subscribe, () => {
    checks += 1;
    expect(ready).toBe(true);
  }).then(() => {
    resolved = true;
  });
  await Promise.resolve();
  expect(resolved).toBe(false);
  notify();
  expect(checks).toBe(2);
  ready = true;
  notify();
  await waiting;
  expect(resolved).toBe(true);
  expect(checks).toBe(3);
  notify();
  expect(checks).toBe(3);
});

test('a non-assertion error rejects immediately and unsubscribes', async () => {
  const { notify, subscribe } = createNotifier();
  const error = new TypeError('The assertion could not read the state.');
  let checks = 0;
  const waiting = waitForState(subscribe, () => {
    checks += 1;
    throw error;
  });
  await expect(waiting).rejects.toBe(error);
  notify();
  expect(checks).toBe(1);
});

test('notifying no listeners or an unsubscribed listener does nothing', () => {
  const { notify, subscribe } = createNotifier();
  notify();
  let calls = 0;
  const unsubscribe = subscribe(() => {
    calls += 1;
  });
  unsubscribe();
  notify();
  expect(calls).toBe(0);
});

test('unsubscribing during notification does not skip the next listener', () => {
  const { notify, subscribe } = createNotifier();
  const calls: string[] = [];
  const unsubscribe = subscribe(() => {
    calls.push('first');
    unsubscribe();
  });
  subscribe(() => calls.push('second'));
  notify();
  expect(calls).toEqual(['first', 'second']);
  notify();
  expect(calls).toEqual(['first', 'second', 'second']);
});

test('a subscription can return a boolean-returning unsubscribe', async () => {
  const listeners = new Set<() => void>();
  await waitForState(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => expect(listeners.size).toBe(1),
  );
  expect(listeners.size).toBe(0);
});
