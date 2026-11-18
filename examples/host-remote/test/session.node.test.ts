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

test.each([200, 503])('ending a session clears its cached token after HTTP %i', async (status) => {
  const origin = 'http://127.0.0.1:4321';
  const expiresAt = Date.now() + 300_000;
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ token: 'old-token', expiresAt }))
    .mockResolvedValueOnce(new Response(null, { status }))
    .mockResolvedValueOnce(Response.json({ token: 'new-token', expiresAt }));
  vi.stubGlobal('fetch', fetchMock);
  const token = createSession(origin);
  await expect(token()).resolves.toBe('old-token');
  const ended = token.end();
  if (status === 200) await expect(ended).resolves.toBeUndefined();
  else await expect(ended).rejects.toMatchObject({ code: 'unavailable' });
  expect(fetchMock).toHaveBeenNthCalledWith(2, `${origin}/api/v1/session/end`, {
    method: 'POST',
    headers: { origin },
    credentials: 'same-origin',
    redirect: 'error',
    cache: 'no-store',
    signal: expect.any(AbortSignal),
  });
  await expect(token()).resolves.toBe('new-token');
  expect(fetchMock).toHaveBeenNthCalledWith(3, `${origin}/api/session`, expect.any(Object));
});

test('ending waits for in-flight issuance before allowing a new session to issue', async () => {
  const { promise, resolve } = Promise.withResolvers<Response>();
  const { promise: ended, resolve: resolveEnd } = Promise.withResolvers<Response>();
  const expiresAt = Date.now() + 300_000;
  const fetchMock = vi
    .fn()
    .mockReturnValueOnce(promise)
    .mockReturnValueOnce(ended)
    .mockResolvedValueOnce(Response.json({ token: 'new-token', expiresAt }));
  vi.stubGlobal('fetch', fetchMock);
  const token = createSession('http://127.0.0.1');
  const issued = token();
  const ending = token.end();
  const next = token();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  resolve(Response.json({ token: 'old-token', expiresAt }));
  await expect(issued).resolves.toBe('old-token');
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(fetchMock.mock.calls[1]?.[0]).toBe('http://127.0.0.1/api/v1/session/end');
  resolveEnd(new Response());
  await ending;
  await expect(next).resolves.toBe('new-token');
});
