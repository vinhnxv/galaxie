// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from 'vitest';
import { z } from 'zod';
import { type CapabilityBinding, httpCapability, type ReconcileResult } from '../src/index.js';
import { binding, brokerFixture } from './fake-executor.js';

const runtimes: Array<{ dispose(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
});

async function createFixture(
  bound: CapabilityBinding,
): Promise<Awaited<ReturnType<typeof brokerFixture>>> {
  const fixture = await brokerFixture({
    requests: { 'write@1': { input: z.string(), output: z.string(), kind: 'write' } },
    bindings: { 'write@1': bound },
  });
  runtimes.push(fixture.runtime);
  return fixture;
}

const reconcile = async (): Promise<ReconcileResult<string>> => ({ outcome: 'unknown' });

describe('reconcile binding validation', () => {
  test('creates a binding with reconciliation and no automatic retry', async () => {
    await expect(
      createFixture(binding({ kind: 'write', retry: 'none', reconcile })),
    ).resolves.toBeDefined();
  });

  test.each(['idempotent', 'idempotency-key'] as const)(
    'rejects reconciliation with retry %s at creation',
    async (retry) => {
      await expect(
        createFixture(binding({ kind: 'write', retry, reconcile })),
      ).rejects.toMatchObject({ code: 'invalid' });
    },
  );

  test('rejects a non-function reconciliation hook at creation', async () => {
    await expect(
      createFixture(
        binding({
          kind: 'write',
          retry: 'none',
          // @ts-expect-error -- runtime validates hooks supplied by untyped hosts.
          reconcile: 'not a function',
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  test('forwards the supplied reconciliation hook through an HTTP binding', () => {
    const bound = httpCapability<unknown, string>({
      ...binding({ kind: 'write' }),
      destination: 'host-server',
      url: 'https://api.example.test/write',
      method: 'POST',
      retry: 'none',
      reconcile,
    });
    expect(bound.reconcile).toBe(reconcile);
  });

  test('creates a binding without a reconciliation hook', async () => {
    await expect(createFixture(binding({ kind: 'write' }))).resolves.toBeDefined();
  });
});
