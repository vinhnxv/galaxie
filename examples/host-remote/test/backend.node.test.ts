// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { request } from 'node:http';
import { lessonFixture, ProgressInputSchema } from '@galaxie/example-english-tutor';
import { createServer, type ViteDevServer } from 'vite';
import { afterEach, expect, it } from 'vitest';
import { backend } from '../server/backend.js';
import { lesson } from '../server/fixtures.js';
import { createSession } from '../src/session.js';

const servers: ViteDevServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function serve(
  mode = 'test',
): Promise<{ origin: string; now: () => number; advance: (ms?: number) => void }> {
  let now = Date.now();
  const server = await createServer({
    configFile: false,
    mode,
    plugins: [backend({ now: () => now })],
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'silent',
  });
  servers.push(server);
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server port.');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    now: () => now,
    advance: (ms = 301_000) => {
      now += ms;
    },
  };
}

async function token(origin: string): Promise<string> {
  const response = await fetch(`${origin}/api/session`, { method: 'POST' });
  expect(response.status).toBe(200);
  const session = (await response.json()) as { token: string; expiresAt: number };
  expect(session.expiresAt).toBeGreaterThan(Date.now());
  return session.token;
}

it('serves the tutor fixture and isolates state per server', async () => {
  expect(lesson).toEqual(lessonFixture);
  const { origin } = await serve();
  const headers = { authorization: `Bearer ${await token(origin)}` };
  expect(await (await fetch(`${origin}/api/lessons/${lesson.id}`, { headers })).json()).toEqual(
    lessonFixture,
  );
  expect((await fetch(`${origin}/api/lessons/unknown`, { headers })).status).toBe(404);
  const state = await (await fetch(`${origin}/api/__test/state`, { headers })).json();
  expect(state).toMatchObject({
    proxyBodies: [],
    progress: [],
    requests: { 'GET /api/lessons/:lessonId': 2 },
  });
  const other = await serve('production');
  const response = await fetch(`${other.origin}/api/__test/state`, {
    headers: { authorization: `Bearer ${await token(other.origin)}` },
  });
  expect(response.status).toBe(404);
});

it('shares a current token, renews within 60 seconds, and saves after the old token expires', async () => {
  const { origin, now, advance } = await serve();
  const currentToken = createSession(origin, now);
  const [first, concurrent] = await Promise.all([currentToken(), currentToken()]);
  expect(concurrent === first).toBe(true);
  expect((await currentToken()) === first).toBe(true);
  advance(240_000);
  const renewed = await currentToken();
  expect(renewed === first).toBe(false);
  advance(61_000);
  expect(
    (
      await fetch(`${origin}/api/progress`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await currentToken()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ lessonId: lesson.id, score: 2, total: 3 }),
      })
    ).status,
  ).toBe(200);
  const headers = { authorization: `Bearer ${renewed}` };
  const state = await (await fetch(`${origin}/api/__test/state`, { headers })).json();
  expect(state.requests['POST /api/session']).toBe(2);
  expect(state.progress).toEqual([
    { learnerId: 'demo-learner', lessonId: lesson.id, score: 2, total: 3 },
  ]);
});

it('rejects absent, unknown and expired tokens and foreign origins and hosts', async () => {
  const { origin, advance } = await serve();
  const url = `${origin}/api/lessons/${lesson.id}`;
  expect((await fetch(url)).status).toBe(401);
  expect((await fetch(url, { headers: { authorization: 'Bearer unknown' } })).status).toBe(401);
  const credential = await token(origin);
  advance();
  expect((await fetch(url, { headers: { authorization: `Bearer ${credential}` } })).status).toBe(
    401,
  );
  expect(
    (
      await fetch(`${origin}/api/session`, {
        method: 'POST',
        headers: { origin: 'http://foreign.invalid' },
      })
    ).status,
  ).toBe(403);
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(
      `${origin}/api/session`,
      {
        method: 'POST',
        headers: { host: 'foreign.invalid', origin: 'http://foreign.invalid' },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on('error', reject);
    req.end();
  });
  expect(status).toBe(403);
});

it('validates progress like the tutor schema and derives the learner from the token', async () => {
  const { origin } = await serve();
  const headers = {
    authorization: `Bearer ${await token(origin)}`,
    'content-type': 'application/json',
  };
  const samples: unknown[] = [
    { lessonId: lesson.id, score: 2, total: 3 },
    { lessonId: lesson.id, score: 0, total: 0 },
    { lessonId: lesson.id, score: 20, total: 20 },
    {},
    null,
    [],
    { lessonId: lesson.id, score: 4, total: 3 },
    { lessonId: lesson.id, score: -1, total: 3 },
    { lessonId: lesson.id, score: 1.5, total: 3 },
    { lessonId: lesson.id, score: 1, total: 21 },
    { lessonId: lesson.id, score: 1, total: 3, learnerId: 'other' },
    { lessonId: '', score: 1, total: 3 },
    { lessonId: '../lesson', score: 1, total: 3 },
    { lessonId: 'a'.repeat(65), score: 1, total: 3 },
    { lessonId: 1, score: 1, total: 3 },
  ];
  for (const sample of samples) {
    const response = await fetch(`${origin}/api/progress`, {
      method: 'POST',
      headers,
      body: JSON.stringify(sample),
    });
    expect(response.status).toBe(ProgressInputSchema.safeParse(sample).success ? 200 : 400);
    if (response.ok) expect(await response.json()).toEqual({ saved: true });
  }
  expect(
    (
      await fetch(`${origin}/api/progress`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ lessonId: 'unknown', score: 1, total: 3 }),
      })
    ).status,
  ).toBe(403);
  const state = await (await fetch(`${origin}/api/__test/state`, { headers })).json();
  expect(state.progress).toEqual([
    { learnerId: 'demo-learner', lessonId: lesson.id, score: 2, total: 3 },
    { learnerId: 'demo-learner', lessonId: lesson.id, score: 0, total: 0 },
    { learnerId: 'demo-learner', lessonId: lesson.id, score: 20, total: 20 },
  ]);
});

it('answers JSON and complete SSE chat requests with usage', async () => {
  const { origin } = await serve();
  const headers = {
    authorization: `Bearer ${await token(origin)}`,
    'content-type': 'application/json',
  };
  for (const stream of [false, true]) {
    const body = {
      model: 'host-quiz',
      messages: [],
      stream,
      response_format: { type: 'json_schema' },
    };
    const response = await fetch(`${origin}/api/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    if (stream) {
      expect(response.headers.get('content-type')).toBe('text/event-stream');
      const frames = (await response.text()).split('\n\n').filter(Boolean);
      expect(frames.pop()).toBe('data: [DONE]');
      const chunks = frames.map((frame) => JSON.parse(frame.slice(6)));
      expect(chunks.at(-1)).toMatchObject({ choices: [], usage: { total_tokens: 40 } });
      expect(chunks.at(-2)).toMatchObject({ choices: [{ finish_reason: 'stop' }] });
      const text = chunks
        .flatMap((chunk) => chunk.choices)
        .map((choice) => choice.delta?.content ?? '')
        .join('');
      expect(JSON.parse(text).questions).toHaveLength(3);
    } else {
      expect(response.headers.get('content-type')).toBe('application/json');
      const reply = await response.json();
      expect(JSON.parse(reply.choices[0].message.content).questions).toHaveLength(3);
      expect(reply.usage.total_tokens).toBe(40);
    }
  }
  const state = await (await fetch(`${origin}/api/__test/state`, { headers })).json();
  expect(state.proxyBodies).toHaveLength(2);
});
