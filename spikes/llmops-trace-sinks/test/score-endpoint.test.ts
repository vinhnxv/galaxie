// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createServer } from 'node:http';
import { afterEach, expect, test } from 'vitest';
import { createScoreEndpoint, type ScoreReport } from '../src/score-endpoint.js';
import { createScoreClient } from '../src/scores.js';

const alice: ScoreReport = {
  runId: 'run-alice',
  segment: 1,
  traceId: 'a'.repeat(32),
  name: 'feedback',
  value: 1,
};
const bob: ScoreReport = {
  runId: 'run-bob',
  segment: 0,
  traceId: 'b'.repeat(32),
  name: 'feedback',
  value: 0.5,
};
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function fixture(
  options: {
    wrongResponse?: boolean;
    failure?: boolean;
    postFailure?: boolean;
    lookupGate?: Promise<void>;
  } = {},
): Promise<{
  report(
    body: unknown,
    cookie?: string,
    headers?: Record<string, string>,
  ): Promise<{ status: number; body: unknown }>;
  aliceCookie: string;
  bobCookie: string;
  calls: { lookup: number; posts: string[] };
}> {
  const calls = { lookup: 0, posts: [] as string[] };
  const scoreClient = createScoreClient({
    authorization: 'synthetic-upstream-key',
    fetch: async (_url, init) => {
      calls.posts.push(String(init?.body));
      if (options.postFailure) throw new Error('synthetic-upstream-key privateUpstreamBody');
      return Response.json({ privateUpstreamBody: 'synthetic-upstream-key' }, { status: 202 });
    },
  });
  const endpoint = createScoreEndpoint({
    scoreClient,
    observations: async (query) => {
      calls.lookup++;
      await options.lookupGate;
      if (options.failure) throw new Error('synthetic-upstream-key privateUpstreamBody');
      const filter = JSON.parse(query['filter'] ?? '[]') as { value: string }[];
      const run = filter[0]?.value;
      const entry = run === alice.runId ? alice : run === bob.runId ? bob : undefined;
      return entry
        ? [
            {
              id: 'root-fixture',
              name: 'invoke_agent fixture',
              sessionId: null,
              startTime: '2026-11-15T00:00:00Z',
              endTime: '2026-11-15T00:00:01Z',
              traceId: options.wrongResponse ? bob.traceId : entry.traceId,
              parentObservationId: null,
              metadata: {
                'galaxie.run.id': options.wrongResponse ? bob.runId : entry.runId,
                'attributes.galaxie.run.segment': entry.segment,
              },
            },
          ]
        : [];
    },
  });
  const server = createServer((request, response) => {
    void endpoint.handle(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No loopback server port');
  return {
    calls,
    aliceCookie: endpoint.issueSession('alice'),
    bobCookie: endpoint.issueSession('bob'),
    async report(body, cookie, headers = {}) {
      const response = await fetch(`http://127.0.0.1:${address.port}/feedback/scores`, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          ...(cookie ? { Cookie: cookie.split(';')[0] ?? '' } : {}),
        },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

test('only issued HttpOnly strict sessions reach the lookup', async () => {
  const f = await fixture();
  expect(f.aliceCookie).toContain('HttpOnly');
  expect(f.aliceCookie).toContain('SameSite=Strict');
  expect((await f.report(alice)).status).toBe(401);
  expect((await f.report(alice, 'llmops-session=unknown')).status).toBe(401);
  expect(f.calls).toEqual({ lookup: 0, posts: [] });
});

test.each(['x-user-id', 'x-user'])(
  'client-supplied %s never selects the score owner',
  async (name) => {
    const f = await fixture();
    expect(await f.report(alice, undefined, { [name]: 'alice' })).toEqual({
      status: 401,
      body: { reason: 'unauthenticated' },
    });
    expect(f.calls).toEqual({ lookup: 0, posts: [] });
    expect((await f.report(alice, f.aliceCookie)).status).toBe(200);
    const before = f.calls.posts.length;
    expect(await f.report(alice, f.bobCookie, { [name]: 'alice' })).toEqual({
      status: 403,
      body: { reason: 'forbidden' },
    });
    expect(f.calls.posts).toHaveLength(before);
    expect((await f.report(alice, f.aliceCookie, { [name]: 'bob' })).status).toBe(200);
  },
);

test.each([
  { ...alice, runId: 'run|delimiter' },
  { ...alice, runId: "run'quote" },
  { ...alice, runId: 'x'.repeat(129) },
  { ...alice, segment: '1' },
  { ...alice, segment: -1 },
  { ...alice, segment: 0.5 },
  { ...alice, traceId: 'A'.repeat(32) },
  { ...alice, traceId: 'unknown' },
  { ...alice, value: '1' },
  { ...alice, value: -0.1 },
  { ...alice, value: 1.1 },
  { ...alice, name: 'other' },
  { ...alice, user: 'alice' },
  null,
])('invalid report is rejected before lookup: %j', async (body) => {
  const f = await fixture();
  expect((await f.report(body, f.aliceCookie)).status).toBe(400);
  expect(f.calls).toEqual({ lookup: 0, posts: [] });
});

test('first report binds, repeats preserve score bytes, and other users cannot reuse the association', async () => {
  const f = await fixture();
  expect(await f.report(alice, f.aliceCookie)).toEqual({ status: 200, body: { reason: 'posted' } });
  expect(await f.report({ ...alice, value: 0 }, f.aliceCookie)).toEqual({
    status: 200,
    body: { reason: 'unchanged' },
  });
  expect(new Set(f.calls.posts).size).toBe(1);
  const before = f.calls.posts.length;
  expect(await f.report(alice, f.bobCookie)).toEqual({
    status: 403,
    body: { reason: 'forbidden' },
  });
  expect(f.calls.posts).toHaveLength(before);
  expect((await f.report(alice, f.aliceCookie)).status).toBe(200);
});

test('owned run paired with another trace fails before binding, whether that trace is bound or unbound', async () => {
  const f = await fixture();
  expect((await f.report(alice, f.aliceCookie)).status).toBe(200);
  const forged = { ...alice, traceId: bob.traceId };
  expect(await f.report(forged, f.aliceCookie)).toEqual({
    status: 404,
    body: { reason: 'not-confirmed' },
  });
  expect((await f.report(bob, f.bobCookie)).status).toBe(200);
  const before = f.calls.posts.length;
  expect((await f.report(forged, f.aliceCookie)).status).toBe(404);
  expect(f.calls.posts).toHaveLength(before);
});

test('wrong segment and unknown trace bind nothing', async () => {
  const f = await fixture();
  expect((await f.report({ ...alice, segment: 0 }, f.bobCookie)).status).toBe(404);
  expect((await f.report({ ...alice, traceId: 'c'.repeat(32) }, f.bobCookie)).status).toBe(404);
  expect((await f.report(alice, f.aliceCookie)).status).toBe(200);
  expect(f.calls.posts).toHaveLength(1);
});

test('confirmation validates returned metadata and trace identity instead of trusting query filters', async () => {
  const f = await fixture({ wrongResponse: true });
  expect((await f.report(alice, f.aliceCookie)).status).toBe(404);
  expect(f.calls.posts).toEqual([]);
});

test('upstream errors remain coarse and do not leak upstream error text', async () => {
  const f = await fixture({ failure: true });
  expect(await f.report(alice, f.aliceCookie)).toEqual({
    status: 502,
    body: { reason: 'upstream-error' },
  });
  expect(f.calls.posts).toEqual([]);
});

test('an upstream post failure retains the confirmed owner for retries', async () => {
  const f = await fixture({ postFailure: true });
  expect(await f.report(alice, f.aliceCookie)).toEqual({
    status: 502,
    body: { reason: 'upstream-error' },
  });
  expect(f.calls.posts).toHaveLength(1);
  expect(await f.report(alice, f.bobCookie)).toEqual({
    status: 403,
    body: { reason: 'forbidden' },
  });
  expect(f.calls.posts).toHaveLength(1);
  expect((await f.report(alice, f.aliceCookie)).status).toBe(502);
  expect(f.calls.posts).toHaveLength(2);
});

test('overlapping first reports bind one owner after both lookups finish', async () => {
  let release: (() => void) | undefined;
  const lookupGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture({ lookupGate });
  const first = f.report(alice, f.aliceCookie);
  const second = f.report(alice, f.bobCookie);
  await expect.poll(() => f.calls.lookup).toBe(2);
  release?.();
  expect((await Promise.all([first, second])).map((result) => result.status).sort()).toEqual([
    200, 403,
  ]);
  expect(f.calls.posts).toHaveLength(1);
});
