// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { RunSnapshot, RunStatus } from '@galaxie-ai/core';
import { expect, test } from 'vitest';
import { waitForRunStatus } from './support/run-status.js';

function observableRun(): {
  getSnapshot(): { readonly run?: Pick<RunSnapshot, 'status' | 'error'> };
  subscribe(listener: () => void): () => void;
  publish(status: RunStatus, error?: RunSnapshot['error']): void;
  readonly listeners: Set<() => void>;
} {
  let run: Pick<RunSnapshot, 'status' | 'error'> | undefined;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => (run === undefined ? {} : { run }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish(status, error) {
      run = { status, ...(error === undefined ? {} : { error }) };
      for (const listener of listeners) listener();
    },
    listeners,
  };
}

test.each(['waiting_input', 'succeeded'] as const)(
  'resolves and unsubscribes when the current status is already %s',
  async (target) => {
    const instance = observableRun();
    instance.publish(target);
    await waitForRunStatus(instance, target);
    expect(instance.listeners.size).toBe(0);
  },
);

test('waits through absent and intermediate states until the target is published', async () => {
  const instance = observableRun();
  let resolved = false;
  const waiting = waitForRunStatus(instance, 'waiting_input').then(() => {
    resolved = true;
  });
  for (const status of ['queued', 'running', 'running', 'suspended'] as const) {
    instance.publish(status);
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(instance.listeners.size).toBe(1);
  }
  instance.publish('waiting_input');
  await waiting;
  expect(resolved).toBe(true);
  expect(instance.listeners.size).toBe(0);
});

test('rejects and unsubscribes on failure with the observed status and error code', async () => {
  const instance = observableRun();
  const waiting = expect(waitForRunStatus(instance, 'waiting_input')).rejects.toThrow(
    'Expected run status waiting_input, observed failed (executor_error).',
  );
  instance.publish('failed', { code: 'executor_error', message: 'The executor failed.' });
  await waiting;
  expect(instance.listeners.size).toBe(0);
});

test.each(['succeeded', 'cancelled'] as const)(
  'rejects and unsubscribes when %s is published instead of the target',
  async (status) => {
    const instance = observableRun();
    const waiting = expect(waitForRunStatus(instance, 'waiting_input')).rejects.toThrow(
      `Expected run status waiting_input, observed ${status}.`,
    );
    instance.publish(status);
    await waiting;
    expect(instance.listeners.size).toBe(0);
  },
);

test('rejects and unsubscribes when the current status is already terminal', async () => {
  const instance = observableRun();
  instance.publish('failed', { code: 'unavailable', message: 'The executor is unavailable.' });
  await expect(waitForRunStatus(instance, 'succeeded')).rejects.toThrow(
    'Expected run status succeeded, observed failed (unavailable).',
  );
  expect(instance.listeners.size).toBe(0);
});
