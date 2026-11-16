// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createServer, request } from 'node:http';
import {
  type CapabilityContext,
  type EffectId,
  httpCapability,
  type RunId,
} from '@galaxie-ai/core';
import { openAICompatible } from '@galaxie-ai/models/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { expect, it } from 'vitest';
import { devGatewayOptions } from '../server/dev.js';
import { createGateway } from '../server/gateway.js';
import { createMockUpstream, mockReply } from '../server/mock-upstream.js';
import { expectedOutput, gatewayReply } from '../src/executor.js';
import { createModelFetch } from '../src/model-fetch.js';
import { createHybridHost } from '../src/runtime.js';
import { createSession } from '../src/session.js';
import { answer, client, completion, harness, listen, post, token } from './support.node.js';

it('refuses missing, unknown and expired tokens before upstream dispatch, including the model client', async () => {
  const server = await harness();
  const expired = await token(server.origin);
  server.advance(300_000);
  for (const credential of [undefined, 'unknown', expired]) {
    const response = await fetch(`${server.origin}/api/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(credential === undefined ? {} : { authorization: `Bearer ${credential}` }),
      },
      body: JSON.stringify(completion()),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'unauthorized' });
    // This is the provider's existing public error contract, distinct from the fixed UI state.
    await expect(
      client(server.origin, credential ?? 'unused', credential === undefined).invoke('Practice.'),
    ).rejects.toMatchObject({
      code: 'unavailable',
      reason: 'not_allowed',
      message: 'The model provider is unavailable.',
    });
  }
  expect(server.records).toEqual([]);
});

it('rejects users outside the table and tokens without the required scope', async () => {
  const server = await harness({
    users: { reader: { documentIds: [], scopes: ['docs.search@1'] } },
  });
  expect((await post(server.origin, '/api/session', '', { userId: 'unknown' })).status).toBe(401);
  const credential = await token(server.origin, 'reader');
  for (const path of ['/api/v1/chat/completions', '/api/notes']) {
    const response = await post(server.origin, path, credential, completion());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
  }
  expect(server.records).toEqual([]);
});

it('reserves per-user quotas before dispatch, survives token renewal and resets by window', async () => {
  const server = await harness({ quota: { calls: 1, windowMs: 60_000 } });
  const ada = await token(server.origin);
  const responses = await Promise.all(
    [1, 2].map(() => post(server.origin, '/api/v1/chat/completions', ada, completion())),
  );
  expect(responses.map((response) => response.status).sort()).toEqual([200, 429]);
  expect(await responses.find((response) => response.status === 429)?.json()).toEqual({
    error: 'quota_exceeded',
  });
  const renewed = await token(server.origin);
  expect(
    (await post(server.origin, '/api/v1/chat/completions', renewed, completion())).status,
  ).toBe(429);
  expect(server.records).toHaveLength(1);
  const lin = await token(server.origin, 'demo-lin');
  expect((await post(server.origin, '/api/v1/chat/completions', lin, completion())).status).toBe(
    200,
  );
  expect(server.records).toHaveLength(2);
  server.advance(60_000);
  expect((await post(server.origin, '/api/v1/chat/completions', ada, completion())).status).toBe(
    200,
  );
  expect(server.records).toHaveLength(3);
});

it('refuses unlisted models, browser system/developer messages, unknown prompts and invalid variables', async () => {
  const server = await harness();
  const credential = await token(server.origin);
  const samples: { overrides: Record<string, unknown>; status: number; error: string }[] = [
    { overrides: { model: 'unlisted' }, status: 403, error: 'model_not_allowed' },
    ...['system', 'developer'].map((role) => ({
      overrides: { messages: [{ role, content: 'browser raw prompt' }] },
      status: 400,
      error: 'invalid_messages',
    })),
    {
      overrides: { metadata: { promptId: 'unknown', variables: {} } },
      status: 400,
      error: 'invalid_prompt',
    },
    ...[
      {},
      { tone: '' },
      { tone: 'x'.repeat(33) },
      { tone: 2 },
      { tone: 'kind', extra: 'bad' },
    ].map((variables) => ({
      overrides: { metadata: { promptId: 'practice-comment', variables } },
      status: 400,
      error: 'invalid_variables',
    })),
  ];
  for (const sample of samples) {
    const response = await post(
      server.origin,
      '/api/v1/chat/completions',
      credential,
      completion(sample.overrides),
    );
    expect(response.status).toBe(sample.status);
    expect(await response.json()).toEqual({ error: sample.error });
  }
  expect(server.records).toEqual([]);
});

it('renders the private system prompt and uses only the server key for JSON and SSE, preserving usage', async () => {
  const server = await harness();
  const credential = await token(server.origin);
  for (const stream of [false, true]) {
    const response = await post(
      server.origin,
      '/api/v1/chat/completions',
      credential,
      completion({ stream, userId: 'demo-lin', principal: 'demo-lin' }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    if (stream) {
      expect(response.headers.get('content-type')).toBe('text/event-stream');
      const frames = (await response.text()).split('\n\n').filter(Boolean);
      expect(frames.pop()).toBe('data: [DONE]');
      expect(JSON.parse(frames.at(-1)?.slice(6) ?? '')).toMatchObject({
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    } else {
      expect(await response.json()).toMatchObject({
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    }
  }
  expect(server.records).toHaveLength(2);
  for (const record of server.records) {
    expect(record.authorization).toBe(`Bearer ${server.apiKey}`);
    expect(record.body['messages']).toEqual([
      {
        role: 'system',
        content:
          'You are a practice coach. Give one short encouraging sentence. Keep it under 20 words.',
      },
      { role: 'user', content: 'A practice comment, please.' },
    ]);
    expect(record.body).not.toHaveProperty('metadata');
    expect(record.body).not.toHaveProperty('userId');
    expect(record.body).not.toHaveProperty('principal');
    expect(JSON.stringify(record)).not.toContain(credential);
  }
  const model = client(server.origin, credential);
  expect((await model.invoke('Practice.')).text).toBe('Keep practicing.');
  const chunks = await model.stream('Practice.');
  let text = '';
  for await (const chunk of chunks) text += chunk.text;
  expect(text).toBe('Keep practicing.');
});

function context(effectId = 'same-effect'): CapabilityContext {
  return {
    signal: new AbortController().signal,
    effectId: effectId as EffectId,
    runId: 'test-run' as RunId,
    principalScope: 'untrusted-client-scope',
    agent: { id: 'test-agent', version: '0.0.0', hash: 'test-hash' },
  };
}

it.each([401, 403, 429, 500])(
  'replaces upstream %s errors with fixed codes and no upstream body or credential',
  async (status) => {
    const server = await harness({}, status);
    const credential = await token(server.origin);
    const response = await post(
      server.origin,
      '/api/v1/chat/completions',
      credential,
      completion(),
    );
    const expected = status === 401 || status === 403 ? 403 : status === 429 ? 429 : 502;
    expect(response.status).toBe(expected);
    expect(await response.json()).toEqual({
      error: expected === 403 ? 'denied' : expected === 429 ? 'quota_exceeded' : 'unavailable',
    });
    expect(server.records).toHaveLength(1);
  },
);

it('deduplicates galaxie HTTP writes by principal, effect and capability, refusing conflicting digests', async () => {
  const server = await harness();
  const ada = await token(server.origin);
  const lin = await token(server.origin, 'demo-lin');
  const statuses: number[] = [];
  const binding = (credential: string) =>
    httpCapability({
      url: `${server.origin}/api/notes`,
      method: 'POST',
      kind: 'write',
      destination: 'host-server',
      approval: 'confirm',
      retry: 'idempotency-key',
      timeoutMs: 10_000,
      concurrency: 1,
      grantScope: 'run',
      credentials: 'omit',
      headers: () => ({
        authorization: `Bearer ${credential}`,
        'Idempotency-Key': 'host-cannot-override',
        'x-user-id': 'demo-lin',
      }),
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        statuses.push(response.status);
        return response;
      },
    });
  const first = await binding(ada).invoke(
    {
      text: 'Ada note',
      userId: 'demo-lin',
      principal: 'demo-lin',
    },
    context(),
  );
  expect(await binding(ada).invoke({ text: 'Ada note' }, context())).toEqual(first);
  expect(server.gateway.notes).toHaveLength(1);
  expect(server.gateway.notes[0]).toMatchObject({ principal: 'demo-ada', text: 'Ada note' });
  await expect(binding(ada).invoke({ text: 'Changed' }, context())).rejects.toMatchObject({
    code: 'invalid',
  });
  expect(statuses.at(-1)).toBe(409);
  const second = await binding(lin).invoke({ text: 'Lin note', userId: 'demo-ada' }, context());
  expect(second).not.toEqual(first);
  expect(server.gateway.notes).toHaveLength(2);
  expect(server.gateway.notes[1]).toMatchObject({ principal: 'demo-lin', text: 'Lin note' });
  expect(await binding(ada).invoke({ text: 'Ada note' }, context())).toEqual(first);
  // If the header callback's override had won, a different effect would conflict with Ada's note.
  await binding(ada).invoke({ text: 'Another effect' }, context('other-effect'));
  expect(server.gateway.notes).toHaveLength(3);
  const missing = await post(server.origin, '/api/notes', ada, { text: 'Missing key' });
  expect(missing.status).toBe(400);
  expect(await missing.json()).toEqual({ error: 'idempotency_key_required' });
});

it('bounds receipts without evicting live records and expires them using the clock', async () => {
  const server = await harness({ idempotency: { maxRecords: 1, ttlMs: 1000 } });
  const ada = await token(server.origin);
  const save = (key: string) =>
    post(server.origin, '/api/notes', ada, { text: 'Note' }, { 'Idempotency-Key': key });
  const first = await (await save('first')).json();
  expect((await save('second')).status).toBe(503);
  expect(await (await save('first')).json()).toEqual(first);
  expect(server.gateway.notes).toHaveLength(1);
  server.advance(1000);
  expect((await save('second')).status).toBe(200);
  expect(server.gateway.notes).toHaveLength(2);
});

it('searches only readable documents through docs.search@1 with bounded results, titles and snippets', async () => {
  const documents = Array.from({ length: 10 }, (_, index) => ({
    id: `doc-${index}`,
    title: `Practice ${'t'.repeat(200)}`,
    text: `Practice ${'s'.repeat(400)}`,
  }));
  const server = await harness({
    documents,
    users: {
      'demo-ada': { documentIds: documents.slice(0, 8).map((document) => document.id) },
      'demo-lin': { documentIds: ['doc-9'] },
    },
  });
  for (const user of ['demo-ada', 'demo-lin']) {
    const credential = await token(server.origin, user);
    const search = httpCapability<
      { q: string; userId: string },
      { results: { id: string; title: string; snippet: string }[] }
    >({
      url: `${server.origin}/api/docs/search?q={q}&userId={userId}`,
      method: 'GET',
      kind: 'read',
      destination: 'host-server',
      approval: 'none',
      retry: 'idempotent',
      timeoutMs: 10_000,
      concurrency: 1,
      grantScope: 'run',
      credentials: 'omit',
      headers: () => ({ authorization: `Bearer ${credential}`, 'x-user-id': 'demo-lin' }),
    });
    const output = await search.invoke({ q: 'Practice', userId: 'demo-lin' }, context());
    expect(output.results.map((document) => document.id)).toEqual(
      user === 'demo-ada' ? ['doc-0', 'doc-1', 'doc-2', 'doc-3', 'doc-4'] : ['doc-9'],
    );
    expect(
      output.results.every(
        (document) => document.snippet.length <= 160 && document.title.length <= 120,
      ),
    ).toBe(true);
    expect(
      (
        await fetch(`${server.origin}/api/docs/search?q=${'x'.repeat(201)}`, {
          headers: { authorization: `Bearer ${credential}` },
        })
      ).status,
    ).toBe(400);
  }
});

it('rejects foreign origins and hosts and caps request bodies with fixed errors', async () => {
  const server = await harness();
  expect(
    (
      await post(
        server.origin,
        '/api/session',
        '',
        { userId: 'demo-ada' },
        {
          origin: 'http://foreign.invalid',
        },
      )
    ).status,
  ).toBe(403);
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const outgoing = request(
      `${server.origin}/api/session`,
      {
        method: 'POST',
        headers: { host: 'foreign.invalid' },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    outgoing.on('error', reject);
    outgoing.end();
  });
  expect(status).toBe(403);
  const credential = await token(server.origin);
  const response = await post(
    server.origin,
    '/api/notes',
    credential,
    { text: 'x'.repeat(20_000) },
    { 'Idempotency-Key': 'large' },
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: 'invalid' });
  expect(server.gateway.notes).toEqual([]);
});

it('shares and renews the in-memory demo session near expiry without persisting credentials', async () => {
  const server = await harness();
  let time = Date.now();
  const session = createSession(
    server.origin,
    fetch,
    () => {},
    () => time,
  );
  const [first, concurrent] = await Promise.all([session.token(), session.token()]);
  expect(concurrent).toBe(first);
  expect(await session.token()).toBe(first);
  time += 240_000;
  server.advance(240_000);
  const renewed = await session.token();
  expect(renewed).not.toBe(first);
  session.reset();
  expect(await session.token()).not.toBe(renewed);
});

it('runs the identical agent through the gateway and keeps credential canaries out of events, snapshots and browser responses', async () => {
  const server = await harness();
  const responses: string[] = [];
  const urls: string[] = [];
  let bearer = '';
  const host = createHybridHost({
    baseURL: server.origin,
    fetch: async (input, init) => {
      urls.push(String(input));
      const response = await fetch(input, init);
      if (new URL(String(input)).pathname === '/api/session') {
        // Session issuance must return the bearer. It is exempt from the subsequent-response scan.
        bearer = ((await response.clone().json()) as { token: string }).token;
      } else responses.push(await response.clone().text());
      return response;
    },
  });
  try {
    const instance = await host.createInstance();
    const events = await answer(instance);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'output',
        output: expectedOutput('Keep practicing.'),
      }),
    );
    expect(instance.getSnapshot().routes?.['comment']).toMatchObject({
      providerId: 'gateway',
      destination: 'host-server',
    });
    expect(bearer.length).toBeGreaterThan(0);
    const visible = JSON.stringify({
      events,
      snapshot: instance.getSnapshot(),
      responses,
      urls,
      status: host.getGatewayState(),
    });
    for (const canary of [bearer, server.apiKey]) expect(visible).not.toContain(canary);
    expect(server.records[0]?.authorization).toBe(`Bearer ${server.apiKey}`);
    expect(host.getGatewayState()).toBe('ready');
  } finally {
    await host.dispose();
  }
});

it('keeps an unconfigured production gateway unavailable and refuses browser prompt roles', async () => {
  const gateway = createGateway();
  const origin = await listen(
    createServer((request, response) => {
      void gateway.handle(request, response);
    }),
  );
  const credential = await token(origin);
  for (const role of ['system', 'developer']) {
    const response = await post(
      origin,
      '/api/v1/chat/completions',
      credential,
      completion({ messages: [{ role, content: 'Browser prompt' }] }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_messages' });
  }
  const response = await post(origin, '/api/v1/chat/completions', credential, completion());
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'unavailable' });
});

it('dispatches JSON and SSE through the credential-free mock after validation and quota reservation', async () => {
  const requests: { authorization: string | null; body: Record<string, unknown> }[] = [];
  const mock = createMockUpstream();
  const gateway = createGateway({
    quota: { calls: 2, windowMs: 60_000 },
    mockUpstream: async (request) => {
      requests.push({
        authorization: request.headers.get('authorization'),
        body: (await request.clone().json()) as Record<string, unknown>,
      });
      return mock(request);
    },
  });
  const origin = await listen(
    createServer((request, response) => {
      void gateway.handle(request, response);
    }),
  );
  const credential = await token(origin);
  for (const [overrides, status] of [
    [{ model: 'unlisted' }, 403],
    ...['system', 'developer'].map(
      (role) => [{ messages: [{ role, content: 'Browser prompt' }] }, 400] as const,
    ),
  ] as const) {
    expect(
      (await post(origin, '/api/v1/chat/completions', credential, completion(overrides))).status,
    ).toBe(status);
  }
  expect((await post(origin, '/api/v1/chat/completions', 'unknown', completion())).status).toBe(
    401,
  );
  expect(requests).toEqual([]);
  for (const stream of [false, true]) {
    const response = await post(
      origin,
      '/api/v1/chat/completions',
      credential,
      completion({ stream }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-galaxie-upstream')).toBe('mock');
    if (stream) {
      expect(response.headers.get('content-type')).toBe('text/event-stream');
      const frames = (await response.text()).split('\n\n').filter(Boolean);
      expect(frames.pop()).toBe('data: [DONE]');
      expect(JSON.parse(frames.at(-1)?.slice(6) ?? '')).toMatchObject({
        usage: { total_tokens: 15 },
      });
    } else
      expect(await response.json()).toMatchObject({
        choices: [{ message: { content: mockReply } }],
        usage: { total_tokens: 15 },
      });
  }
  expect(requests).toHaveLength(2);
  for (const request of requests) {
    expect(request.authorization).toBeNull();
    expect(request.body['messages']).toEqual([
      {
        role: 'system',
        content:
          'You are a practice coach. Give one short encouraging sentence. Keep it under 20 words.',
      },
      { role: 'user', content: 'A practice comment, please.' },
    ]);
    expect(request.body).not.toHaveProperty('metadata');
  }
});

it('reserves concurrent mock calls before dispatch', async () => {
  let calls = 0;
  const mock = createMockUpstream();
  const gateway = createGateway({
    quota: { calls: 1, windowMs: 60_000 },
    mockUpstream: (request) => {
      calls++;
      return mock(request);
    },
  });
  const origin = await listen(
    createServer((request, response) => {
      void gateway.handle(request, response);
    }),
  );
  const credential = await token(origin);
  const responses = await Promise.all(
    [1, 2].map(() => post(origin, '/api/v1/chat/completions', credential, completion())),
  );
  expect(responses.map((response) => response.status).sort()).toEqual([200, 429]);
  expect(calls).toBe(1);
});

it('selects the dev mock only for empty upstream configuration and prefers a configured upstream', async () => {
  const previous = [process.env['UPSTREAM_BASE_URL'], process.env['UPSTREAM_API_KEY']];
  const upstream = await harness();
  try {
    for (const [base, key, kind] of [
      [undefined, undefined, 'mock'],
      ['', '', 'mock'],
      [upstream.upstreamOrigin + '/v1', undefined, 'unavailable'],
      [undefined, upstream.apiKey, 'unavailable'],
      [upstream.upstreamOrigin + '/v1', upstream.apiKey, 'real'],
    ] as const) {
      for (const [name, value] of [
        ['UPSTREAM_BASE_URL', base],
        ['UPSTREAM_API_KEY', key],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      const options = devGatewayOptions();
      expect(Boolean(options.mockUpstream)).toBe(kind === 'mock');
      expect(Boolean(options.upstream)).toBe(kind === 'real');
      const gateway = createGateway(options);
      const origin = await listen(
        createServer((request, response) => {
          void gateway.handle(request, response);
        }),
      );
      const response = await post(
        origin,
        '/api/v1/chat/completions',
        await token(origin),
        completion(),
      );
      expect(response.status).toBe(kind === 'unavailable' ? 503 : 200);
      expect(response.headers.get('x-galaxie-upstream')).toBe(kind === 'mock' ? 'mock' : null);
    }
    expect(upstream.records).toHaveLength(1);
  } finally {
    for (const [index, name] of ['UPSTREAM_BASE_URL', 'UPSTREAM_API_KEY'].entries()) {
      const value = previous[index];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

it('drops agent system and developer roles while preserving conversational messages and host metadata', async () => {
  const seen: unknown[] = [];
  const states: string[] = [];
  const mock = createMockUpstream();
  const gateway = createGateway({
    mockUpstream: async (request) => {
      seen.push(await request.clone().json());
      return mock(request);
    },
  });
  const origin = await listen(
    createServer((request, response) => {
      void gateway.handle(request, response);
    }),
  );
  const credential = await token(origin);
  const modelFetch = createModelFetch(fetch, (state) => states.push(state));
  const messages = [
    { role: 'system', content: 'Agent system' },
    { role: 'user', content: 'Question' },
    { role: 'developer', content: 'Agent developer' },
    { role: 'assistant', content: 'Answer' },
  ];
  const response = await modelFetch(`${origin}/api/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
    body: JSON.stringify(completion({ messages, metadata: { promptId: 'forged' } })),
  });
  expect(response.status).toBe(200);
  expect(seen).toEqual([
    expect.objectContaining({
      messages: [
        {
          role: 'system',
          content:
            'You are a practice coach. Give one short encouraging sentence. Keep it under 20 words.',
        },
        messages[1],
        messages[3],
      ],
    }),
  ]);
  expect(states).toEqual(['mock']);
  const direct = await post(
    origin,
    '/api/v1/chat/completions',
    credential,
    completion({ messages }),
  );
  expect(direct.status).toBe(400);
  expect(await direct.json()).toEqual({ error: 'invalid_messages' });
  const missing = await modelFetch(`${origin}/api/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${credential}` },
    body: JSON.stringify({ model: 'gateway-comment' }),
  });
  expect(missing.status).toBe(400);
  expect(await missing.json()).toEqual({ error: 'invalid_messages' });
});

it('answers SystemMessage requests through the real OpenAI-compatible client in JSON and SSE', async () => {
  const gateway = createGateway({ mockUpstream: createMockUpstream() });
  const origin = await listen(
    createServer((request, response) => {
      void gateway.handle(request, response);
    }),
  );
  const model = openAICompatible({
    baseURL: `${origin}/api/v1`,
    model: 'gateway-comment',
    destination: 'host-server',
    fetch: createModelFetch(fetch, () => {}),
  })({ credential: await token(origin) });
  const messages = [new SystemMessage('Agent-authored prompt'), new HumanMessage('Practice.')];
  expect((await model.invoke(messages)).text).toBe('This is a fixed reply from the mock upstream.');
  let text = '';
  for await (const chunk of await model.stream(messages)) text += chunk.text;
  expect(text).toBe('This is a fixed reply from the mock upstream.');
  const host = createHybridHost({ baseURL: origin });
  try {
    const events = await answer(await host.createInstance());
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'output',
        output: expectedOutput(gatewayReply),
      }),
    );
    expect(host.getGatewayState()).toBe('mock');
  } finally {
    await host.dispose();
  }
});

it.each([200, 401, 429, 503])(
  'uses the mock label only on successful responses (%s)',
  async (status) => {
    const states: string[] = [];
    const fetcher = createModelFetch(
      async (_input, init) => {
        expect(init).toMatchObject({ credentials: 'omit', redirect: 'error', cache: 'no-store' });
        const payload = JSON.parse(String(init?.body));
        expect(payload).not.toHaveProperty('messages');
        return Response.json({}, { status, headers: { 'x-galaxie-upstream': 'mock' } });
      },
      (state) => states.push(state),
    );
    await fetcher('http://127.0.0.1/api/v1/chat/completions', { method: 'POST', body: '{}' });
    expect(states).toEqual([
      status === 200
        ? 'mock'
        : status === 401
          ? 'denied'
          : status === 429
            ? 'quota_exceeded'
            : 'unavailable',
    ]);
  },
);
