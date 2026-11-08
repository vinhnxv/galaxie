// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { acquireOwnership, type Ownership, type OwnershipOptions } from '@galaxie-ai/core/browser';
import { afterEach, describe, expect, test, vi } from 'vitest';

const owners: Ownership[] = [];
const channels: BroadcastChannel[] = [];
const options = (): OwnershipOptions => ({
  appId: crypto.randomUUID(),
  onHandoverRequest: () => {},
});
async function owner(opts: OwnershipOptions): Promise<Ownership> {
  const result = await acquireOwnership(opts);
  if (result.status !== 'owner') throw new Error('Expected ownership.');
  owners.push(result.ownership);
  return result.ownership;
}
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const channel of channels.splice(0)) channel.close();
  for (const owned of owners.splice(0)) await owned.release();
});
describe('Web Lock ownership', () => {
  test('reports busy and releases idempotently with a fixed reason', async () => {
    const opts = options();
    const a = await owner(opts);
    expect(await acquireOwnership(opts)).toEqual({ status: 'busy' });
    expect(await a.verify()).toBe(true);
    await Promise.all([a.release(), a.release()]);
    expect(a.signal.aborted).toBe(true);
    expect(a.signal.reason).toBe('released');
    expect(a.lostReason).toBe('released');
    expect(await a.verify()).toBe(false);
    await owner(opts);
  });
  test('hands over cooperatively, ignores malformed messages and runs the hook once', async () => {
    const opts = options();
    const hook = vi.fn();
    const finish = Promise.withResolvers<void>();
    const called = Promise.withResolvers<void>();
    const a = await owner({
      ...opts,
      onHandoverRequest: async () => {
        hook();
        called.resolve();
        await finish.promise;
      },
    });
    const channel = new BroadcastChannel(`galaxie:${opts.appId}:runtime`);
    channels.push(channel);
    channel.postMessage({ v: 2, type: 'handover' });
    channel.postMessage({ v: 1, type: 'handover', text: 'private content' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hook).not.toHaveBeenCalled();
    const b = owner({ ...opts, takeover: true, handoverTimeoutMs: 1000 });
    await called.promise;
    channel.postMessage({ v: 1, type: 'handover' });
    finish.resolve();
    await b;
    expect(hook).toHaveBeenCalledTimes(1);
    expect(a.lostReason).toBe('handover');
    expect(a.signal.reason).toBe('handover');
  });
  test('releases even if the handover hook rejects without exposing host text', async () => {
    const opts = options();
    const a = await owner({
      ...opts,
      onHandoverRequest: () => {
        throw new Error('private hook text');
      },
    });
    await owner({ ...opts, takeover: true, handoverTimeoutMs: 1000 });
    expect(a.lostReason).toBe('handover');
  });
  test('steals after a stalled hook and reports stolen to the former owner', async () => {
    const opts = options();
    const a = await owner({ ...opts, onHandoverRequest: () => new Promise(() => {}) });
    const b = await owner({ ...opts, takeover: true, handoverTimeoutMs: 25 });
    await vi.waitFor(() => expect(a.lostReason).toBe('stolen'));
    expect(a.signal.reason).toBe('stolen');
    expect(await a.verify()).toBe(false);
    expect(await b.verify()).toBe(true);
    const channel = new BroadcastChannel(`galaxie:${opts.appId}:runtime`);
    channels.push(channel);
    channel.postMessage({ v: 1, type: 'handover' });
    await vi.waitFor(() => expect(b.lostReason).toBe('handover'));
  });
  test.each(['false', 'reject'] as const)(
    'verify fences a stale owner when current returns %s',
    async (mode) => {
      let live = true;
      const a = await owner({
        ...options(),
        fence: {
          claim: async () => {},
          current: async () => {
            if (!live && mode === 'reject') throw new Error('private storage text');
            return live;
          },
        },
      });
      live = false;
      expect(await a.verify()).toBe(false);
      expect(a.lostReason).toBe('stale');
    },
  );
  test('checks persisted pageshow events and removes its listener after loss', async () => {
    const target = new EventTarget();
    const add = vi.fn(target.addEventListener.bind(target));
    const remove = vi.fn(target.removeEventListener.bind(target));
    vi.stubGlobal('addEventListener', add);
    vi.stubGlobal('removeEventListener', remove);
    let live = true;
    const a = await owner({
      ...options(),
      fence: { claim: async () => {}, current: async () => live },
    });
    live = false;
    target.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }));
    expect(a.signal.aborted).toBe(false);
    target.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    await vi.waitFor(() => expect(a.lostReason).toBe('stale'));
    expect(remove).toHaveBeenCalledTimes(1);
  });
  test('awaits claim and releases the lock if claim fails', async () => {
    const opts = options();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let resolved = false;
    const pending = owner({
      ...opts,
      fence: {
        claim: async () => {
          started.resolve();
          await finish.promise;
        },
        current: async () => true,
      },
    }).then((value) => {
      resolved = true;
      return value;
    });
    await started.promise;
    expect(resolved).toBe(false);
    finish.resolve();
    await (await pending).release();
    await expect(
      acquireOwnership({
        ...opts,
        fence: {
          claim: async () => {
            throw new Error('private claim text');
          },
          current: async () => true,
        },
      }),
    ).rejects.toMatchObject({
      code: 'unavailable',
      message: 'The requested service is unavailable.',
    });
    await owner(opts);
  });
  test('keeps the public result pending until the storage claim finishes', async () => {
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let resolved = false;
    const pending = owner({
      ...options(),
      fence: {
        claim: async () => {
          entered.resolve();
          await finish.promise;
        },
        current: async () => true,
      },
    }).then((value) => {
      resolved = true;
      return value;
    });
    try {
      await entered.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(resolved).toBe(false);
    } finally {
      finish.resolve();
      await (await pending).release();
    }
  });
  test('does not retry a granted claim that fails after the handover wait deadline', async () => {
    const opts = options();
    const a = await owner(opts);
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let claims = 0;
    const pending = acquireOwnership({
      ...opts,
      takeover: true,
      handoverTimeoutMs: 250,
      fence: {
        claim: async () => {
          claims++;
          if (claims === 1) {
            entered.resolve();
            await finish.promise;
            throw new Error('private delayed claim failure');
          }
        },
        current: async () => true,
      },
    }).then(
      (result) => {
        if (result.status === 'owner') owners.push(result.ownership);
        return result;
      },
      (error: unknown) => error,
    );
    await entered.promise;
    await new Promise((resolve) => setTimeout(resolve, 300));
    finish.resolve();
    const outcome = await pending;
    expect(a.lostReason).toBe('handover');
    expect(claims).toBe(1);
    expect(outcome).toMatchObject({
      code: 'unavailable',
      message: 'The requested service is unavailable.',
    });
    expect(outcome).not.toHaveProperty('cause');
  });
  test.each([
    { appId: '' },
    { appId: 'bad app' },
    { appId: 'a'.repeat(129) },
    { takeover: 'yes' },
    { handoverTimeoutMs: 0 },
    { handoverTimeoutMs: Infinity },
    { handoverTimeoutMs: NaN },
    { onHandoverRequest: null },
    { fence: {} },
  ])('rejects invalid options %#', async (invalid) => {
    await expect(
      acquireOwnership({ ...options(), ...invalid } as OwnershipOptions),
    ).rejects.toMatchObject({ code: 'invalid' });
  });
  test.each(['navigator', 'BroadcastChannel'])(
    'requires %s without changing other tests',
    async (name) => {
      vi.stubGlobal(name, undefined);
      await expect(acquireOwnership(options())).rejects.toMatchObject({ code: 'unsupported' });
    },
  );
});
