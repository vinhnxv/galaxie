// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, test, vi } from 'vitest';
import { createSession } from '../src/session.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('session issue sends its exact Origin and permits same-origin cookies', async () => {
  const origin = 'http://127.0.0.1:4321';
  const fetchMock = vi
    .fn()
    .mockResolvedValue(Response.json({ token: 'demo-token', expiresAt: Date.now() + 300_000 }));
  vi.stubGlobal('fetch', fetchMock);
  await expect(createSession(origin)()).resolves.toBe('demo-token');
  expect(fetchMock).toHaveBeenCalledWith(`${origin}/api/session`, {
    method: 'POST',
    headers: { origin },
    credentials: 'same-origin',
    redirect: 'error',
    cache: 'no-store',
    signal: expect.any(AbortSignal),
  });
});

test('a stalled session request ends at its deadline and a later call starts a new request', async () => {
  const deadline = new AbortController();
  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
  const fetchMock = vi.fn(
    (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        if (fetchMock.mock.calls.length === 1) {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        } else {
          resolve(Response.json({ token: 'fresh-token', expiresAt: Date.now() + 10 * 60_000 }));
        }
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const token = createSession('http://127.0.0.1');
  const first = token();
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  deadline.abort();
  await expect(first).rejects.toMatchObject({ code: 'unavailable' });
  await expect(token()).resolves.toBe('fresh-token');
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
