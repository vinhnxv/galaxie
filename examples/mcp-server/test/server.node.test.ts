// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, expect, test } from 'vitest';
import { startMcpServer } from '../src/index.js';

const origin = 'http://127.0.0.1:63315';
const token = crypto.randomUUID();
const otherToken = crypto.randomUUID();
const servers: Awaited<ReturnType<typeof startMcpServer>>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function setup(): Promise<Awaited<ReturnType<typeof startMcpServer>>> {
  const server = await startMcpServer({
    allowedOrigins: [origin],
    verifyToken: (value) => (value === token ? 'one' : value === otherToken ? 'two' : undefined),
  });
  servers.push(server);
  return server;
}

function headers(bearer: string = token): Record<string, string> {
  return {
    origin,
    authorization: `Bearer ${bearer}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
}

async function initialize(url: string, bearer: string = token): Promise<string> {
  const response = await fetch(url, {
    method: 'POST',
    headers: headers(bearer),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      },
    }),
  });
  expect(response.status).toBe(200);
  await response.text();
  return response.headers.get('mcp-session-id') as string;
}

test('enforces origin, authentication, session principal and CORS on the HTTP boundary', async () => {
  const server = await setup();
  expect(new URL(server.url).hostname).toBe('127.0.0.1');
  expect(
    (await fetch(server.url, { headers: { ...headers(), origin: 'http://127.0.0.1:1' } })).status,
  ).toBe(403);
  expect((await fetch(server.url, { headers: { origin } })).status).toBe(401);
  expect((await fetch(server.url, { headers: headers('invalid') })).status).toBe(401);
  const preflight = await fetch(server.url, {
    method: 'OPTIONS',
    headers: { origin, 'access-control-request-method': 'POST' },
  });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get('access-control-allow-origin')).toBe(origin);
  expect(preflight.headers.get('access-control-allow-methods')).toBe('GET, POST, DELETE');
  expect(preflight.headers.get('access-control-allow-headers')).toBe(
    'authorization, content-type, mcp-session-id, mcp-protocol-version, last-event-id',
  );
  expect(preflight.headers.get('access-control-expose-headers')).toBe('mcp-session-id');
  const session = await initialize(server.url);
  expect(
    (
      await fetch(server.url, {
        method: 'DELETE',
        headers: { ...headers(otherToken), 'mcp-session-id': session },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await fetch(server.url, {
        method: 'DELETE',
        headers: { ...headers(), 'mcp-session-id': 'unknown' },
      })
    ).status,
  ).toBe(404);
});

test('deduplicates progress effects within the authenticated principal', async () => {
  const server = await setup();
  const session = await initialize(server.url);
  for (const id of [2, 3]) {
    const response = await fetch(server.url, {
      method: 'POST',
      headers: { ...headers(), 'mcp-session-id': session, 'mcp-protocol-version': '2025-11-25' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: {
          name: 'progress.record',
          arguments: { lessonId: 'lesson-1' },
          _meta: { 'galaxie.dev/effect': 'same-effect' },
        },
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"count":1');
  }
  expect(server.admin.counters()).toEqual({ one: 1 });
});

test('keeps effect deduplication scoped to authenticated principals despite spoofed attribution', async () => {
  const server = await setup();
  for (const bearer of [token, otherToken]) {
    const session = await initialize(server.url, bearer);
    const response = await fetch(server.url, {
      method: 'POST',
      headers: {
        ...headers(bearer),
        'mcp-session-id': session,
        'mcp-protocol-version': '2025-11-25',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'progress.record',
          arguments: { lessonId: 'lesson-1' },
          _meta: {
            'galaxie.dev/effect': 'same-effect',
            'galaxie.dev/agent': 'spoofed-agent',
            'galaxie.dev/run': 'spoofed-run',
          },
        },
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"count":1');
  }
  expect(server.admin.counters()).toEqual({ one: 1, two: 1 });
});
