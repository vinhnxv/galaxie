// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { startFixtures } from './servers.ts';

test('proxy scopes credentials and rejects origins, expiry, paths and methods', async () => {
  const fixtures = await startFixtures();
  const clients: Client[] = [];
  try {
    const { proxy, page, upstream, mcp } = fixtures.origins;
    const tokenResponse = await fetch(`${proxy}/token`, {
      method: 'POST',
      headers: { Origin: page },
    });
    const { token, expiresIn } = (await tokenResponse.json()) as {
      token: string;
      expiresIn: number;
    };
    assert.equal(expiresIn, 60);
    const headers = {
      Origin: page,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    const response = await fetch(`${proxy}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'normal', messages: [] }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), page);
    assert.equal(
      (
        await fetch(`${proxy}/v1/chat/completions`, {
          method: 'POST',
          headers: { ...headers, Origin: `${page}/wrong` },
        })
      ).status,
      403,
    );
    assert.equal((await fetch(`${proxy}/other`, { method: 'POST', headers })).status, 404);
    assert.equal((await fetch(`${proxy}/v1/chat/completions`, { headers })).status, 405);
    fixtures.expireTokens();
    assert.equal(
      (await fetch(`${proxy}/v1/chat/completions`, { method: 'POST', headers })).status,
      401,
    );
    assert.equal(
      (
        await fetch(`${upstream}/v1/chat/completions`, {
          method: 'POST',
          headers: { Origin: page },
          body: '{}',
        })
      ).status,
      401,
    );
    assert.equal(
      (await fetch(`${mcp}/mcp`, { method: 'POST', headers: { Origin: 'http://127.0.0.1:1' } }))
        .status,
      403,
    );
    assert.equal(
      (
        await fetch(`${mcp}/mcp`, {
          method: 'OPTIONS',
          headers: {
            Origin: page,
            'Access-Control-Request-Headers': 'mcp-session-id,mcp-protocol-version',
          },
        })
      ).status,
      204,
    );
    assert.equal(fixtures.exposure().browserTokenForwarded, false);
    assert.equal(fixtures.requests.filter((r) => r.server === 'upstream').length, 2);
    const initialize = await fetch(`${mcp}/mcp`, {
      method: 'POST',
      headers: {
        Origin: page,
        Authorization: `Bearer ${fixtures.issueMcpCredential('learner-a')}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'node-test', version: '1' },
        },
      }),
    });
    assert.equal(initialize.status, 200);
    const sessionId = initialize.headers.get('mcp-session-id');
    assert.ok(sessionId);
    await initialize.body?.cancel();
    const denied = await fetch(`${mcp}/mcp`, {
      method: 'GET',
      headers: {
        Origin: page,
        Authorization: `Bearer ${fixtures.issueMcpCredential('learner-b')}`,
        'mcp-session-id': sessionId,
      },
    });
    assert.equal(denied.status, 403);
    assert.equal(
      (await fetch(`${mcp}/mcp`, { method: 'GET', headers: { Origin: page } })).status,
      401,
    );
    for (const principal of ['learner-a', 'learner-b'] as const) {
      const client = new Client({ name: 'fixture-test', version: '1' }, { capabilities: {} });
      clients.push(client);
      const transport = new StreamableHTTPClientTransport(new URL(`${fixtures.origins.mcp}/mcp`), {
        requestInit: {
          headers: {
            Origin: fixtures.origins.page,
            Authorization: `Bearer ${fixtures.issueMcpCredential(principal)}`,
          },
        },
      });
      await client.connect(transport as Transport);
      const first = await client.callTool({ name: 'progress.record', arguments: {} });
      assert.ok(first.structuredContent && typeof first.structuredContent === 'object');
      assert.equal(Reflect.get(first.structuredContent, 'recorded'), 1);
      await client.callTool({ name: 'lesson.lookup', arguments: {} });
      const second = await client.callTool({ name: 'progress.record', arguments: {} });
      assert.ok(second.structuredContent && typeof second.structuredContent === 'object');
      assert.equal(Reflect.get(second.structuredContent, 'recorded'), 2);
    }
  } finally {
    for (const client of clients) await client.close();
    await fixtures.close();
  }
});
