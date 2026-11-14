// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { lessonFixture, ProgressInputSchema } from '@galaxie-ai/example-english-tutor';
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
  upstreamKey?: string,
): Promise<{ origin: string; now: () => number; advance: (ms?: number) => void }> {
  let now = Date.now();
  const server = await createServer({
    configFile: false,
    mode,
    plugins: [backend({ now: () => now, ...(upstreamKey ? { upstreamKey } : {}) })],
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
  const response = await fetch(`${origin}/api/session`, { method: 'POST', headers: { origin } });
  expect(response.status).toBe(200);
  const session = (await response.json()) as { token: string; expiresAt: number };
  expect(session.expiresAt).toBeGreaterThan(Date.now());
  return session.token;
}

async function issueSession(origin: string): Promise<{
  token: string;
  cookie: string;
  cookieValue: string;
  setCookie: string;
  responseBody: string;
}> {
  const response = await fetch(`${origin}/api/session`, { method: 'POST', headers: { origin } });
  expect(response.status).toBe(200);
  const responseBody = await response.text();
  const setCookie = response.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';')[0] ?? '';
  expect(cookie).toMatch(/^galaxie-agent-session=.+/);
  return {
    token: (JSON.parse(responseBody) as { token: string }).token,
    cookie,
    cookieValue: cookie.slice(cookie.indexOf('=') + 1),
    setCookie,
    responseBody,
  };
}

it('uses a separate HttpOnly model cookie and forwards only allowlisted headers with the server key', async () => {
  const upstreamKey = randomUUID();
  const { origin } = await serve('test', upstreamKey);
  const session = await issueSession(origin);
  expect(session.setCookie.split(';').map((attribute) => attribute.trim())).toEqual([
    session.cookie,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/api/v1',
    'Max-Age=300',
  ]);
  expect(session.cookieValue).not.toBe(session.token);
  const bodies = [session.responseBody];
  const headers = [session.setCookie];
  async function capture(path: string, init: RequestInit, status: number): Promise<string> {
    const response = await fetch(`${origin}${path}`, init);
    expect(response.status).toBe(status);
    headers.push(JSON.stringify([...response.headers]));
    const text = await response.text();
    bodies.push(text);
    return text;
  }
  const modelPath = '/api/v1/chat/completions';
  const modelHeaders = {
    origin,
    cookie: session.cookie,
    authorization: 'Bearer host-remote-placeholder',
    'content-type': 'application/json',
    accept: 'application/json',
    'x-forwarded-for': '192.0.2.1',
    'x-authorization': 'untrusted-header',
  };
  for (const stream of [false, true]) {
    await capture(
      modelPath,
      {
        method: 'POST',
        headers: modelHeaders,
        body: JSON.stringify({ stream, messages: [] }),
      },
      200,
    );
  }
  await capture(
    modelPath,
    {
      method: 'POST',
      headers: { ...modelHeaders, authorization: 'arbitrary' },
      body: '{}',
    },
    200,
  );
  for (const authorization of [`Bearer ${session.token}`, 'arbitrary']) {
    await capture(
      modelPath,
      {
        method: 'POST',
        headers: { origin, authorization },
        body: '{}',
      },
      401,
    );
  }
  await capture(`/api/lessons/${lesson.id}`, { headers: { cookie: session.cookie, origin } }, 401);
  await capture(
    '/api/progress',
    {
      method: 'POST',
      headers: { cookie: session.cookie, origin },
      body: '{}',
    },
    401,
  );
  await capture(
    modelPath,
    {
      method: 'POST',
      headers: { ...modelHeaders, origin: 'http://foreign.invalid' },
      body: '{}',
    },
    403,
  );
  await capture(
    '/api/lessons/unknown',
    {
      headers: { authorization: `Bearer ${session.token}` },
    },
    404,
  );
  const state = JSON.parse(
    await capture(
      '/api/__test/state',
      {
        headers: { authorization: `Bearer ${session.token}` },
      },
      200,
    ),
  );
  expect(state.proxyBodies).toEqual([
    { stream: false, messages: [] },
    { stream: true, messages: [] },
    {},
  ]);
  expect(state.proxyHeaderNames).toEqual(
    Array.from({ length: 3 }, () => ['accept', 'authorization', 'content-type']),
  );
  expect(JSON.stringify([...bodies, ...headers])).not.toContain(upstreamKey);
  for (const text of bodies) {
    expect(text).not.toContain(session.cookieValue);
    expect(text).not.toContain('host-remote-placeholder');
    expect(text).not.toContain('untrusted-header');
  }
});

it('rejects expired and duplicate model cookies', async () => {
  const { origin, advance } = await serve();
  const { cookie } = await issueSession(origin);
  const post = (value: string): Promise<Response> =>
    fetch(`${origin}/api/v1/chat/completions`, {
      method: 'POST',
      headers: { origin, cookie: value },
      body: '{}',
    });
  expect((await post(`${cookie}; galaxie-agent-session=other`)).status).toBe(401);
  expect((await post(`galaxie-agent-session=other; ${cookie}`)).status).toBe(401);
  advance(300_000);
  expect((await post(cookie)).status).toBe(401);
});

it('ends the cookie-identified session and clears the cookie even without a live session', async () => {
  const { origin, advance } = await serve();
  const session = await issueSession(origin);
  const end = async (cookie?: string): Promise<void> => {
    const response = await fetch(`${origin}/api/v1/session/end`, {
      method: 'POST',
      headers: { origin, ...(cookie === undefined ? {} : { cookie }) },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBe(
      'galaxie-agent-session=; HttpOnly; SameSite=Strict; Path=/api/v1; Max-Age=0',
    );
    expect(await response.json()).toEqual({ ended: true });
  };
  await end(session.cookie);
  expect(
    (
      await fetch(`${origin}/api/v1/chat/completions`, {
        method: 'POST',
        headers: { origin, cookie: session.cookie },
        body: '{}',
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await fetch(`${origin}/api/lessons/${lesson.id}`, {
        headers: { authorization: `Bearer ${session.token}` },
      })
    ).status,
  ).toBe(401);
  await end();
  await end(session.cookie);
  const renewed = await issueSession(origin);
  await end(`${renewed.cookie}; galaxie-agent-session=other`);
  advance();
  await end(renewed.cookie);
});

it('requires an exact Origin on cookie routes while bearer-only routes allow an absent Origin', async () => {
  const { origin } = await serve();
  const session = await issueSession(origin);
  for (const path of ['/api/session', '/api/v1/chat/completions', '/api/v1/session/end']) {
    for (const supplied of [undefined, 'null', `${origin}.foreign.invalid`, 'http://127.0.0.1:1']) {
      const response = await fetch(`${origin}${path}`, {
        method: 'POST',
        headers: {
          cookie: session.cookie,
          ...(supplied === undefined ? {} : { origin: supplied }),
        },
        body: '{}',
      });
      expect(response.status).toBe(403);
    }
  }
  const headers = { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' };
  const body = JSON.stringify({ lessonId: lesson.id, score: 2, total: 3 });
  expect((await fetch(`${origin}/api/progress`, { method: 'POST', headers, body })).status).toBe(
    200,
  );
  expect(
    (
      await fetch(`${origin}/api/progress`, {
        method: 'POST',
        headers: { ...headers, origin: 'http://foreign.invalid' },
        body,
      })
    ).status,
  ).toBe(403);
});

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
  const hostOnlyStatus = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(
      `${origin}/api/session`,
      {
        method: 'POST',
        headers: { host: `127.0.0.2:${new URL(origin).port}`, origin },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on('error', reject);
    req.end();
  });
  expect(hostOnlyStatus).toBe(403);
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
  const issued = await fetch(`${origin}/api/session`, { method: 'POST', headers: { origin } });
  const cookie = issued.headers.get('set-cookie')?.split(';')[0];
  expect(cookie).toBeTruthy();
  const headers = {
    authorization: `Bearer ${await token(origin)}`,
    cookie: cookie as string,
    origin,
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
