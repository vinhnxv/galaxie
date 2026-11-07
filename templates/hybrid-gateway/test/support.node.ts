// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { type OpenAICompatibleChatModel, openAICompatible } from '@galaxie/models/openai';
import { afterEach, expect } from 'vitest';
import { createGateway, type Gateway, type GatewayOptions } from '../server/gateway.js';
import type { HybridInstance } from '../src/runtime.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
});

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

export async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Missing loopback port.');
  return `http://127.0.0.1:${address.port}`;
}

export interface UpstreamRecord {
  readonly authorization: string | undefined;
  readonly body: Record<string, unknown>;
}

export interface Harness {
  readonly origin: string;
  readonly upstreamOrigin: string;
  readonly apiKey: string;
  readonly gateway: Gateway;
  readonly records: UpstreamRecord[];
  advance(ms: number): void;
}

export async function harness(
  options: GatewayOptions = {},
  upstreamStatus = 200,
): Promise<Harness> {
  const records: UpstreamRecord[] = [];
  const apiKey = randomUUID();
  const upstreamOrigin = await listen(
    createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
        records.push({ authorization: request.headers.authorization, body });
        if (upstreamStatus !== 200) {
          response.writeHead(upstreamStatus, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: apiKey }));
          return;
        }
        const envelope = { id: 'practice-reply', created: 0, model: 'gateway-comment' };
        const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
        if (body['stream'] === true) {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          for (const frame of [
            {
              ...envelope,
              object: 'chat.completion.chunk',
              choices: [
                {
                  index: 0,
                  delta: { role: 'assistant', content: 'Keep practicing.' },
                  finish_reason: null,
                },
              ],
            },
            {
              ...envelope,
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            },
            { ...envelope, object: 'chat.completion.chunk', choices: [], usage },
          ])
            response.write(`data: ${JSON.stringify(frame)}\n\n`);
          response.end('data: [DONE]\n\n');
        } else {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              ...envelope,
              object: 'chat.completion',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'Keep practicing.' },
                  finish_reason: 'stop',
                },
              ],
              usage,
            }),
          );
        }
      })().catch(() => {
        response.writeHead(500);
        response.end();
      });
    }),
  );
  let time = Date.now();
  const gateway = createGateway({
    upstream: { baseURL: `${upstreamOrigin}/v1`, apiKey },
    now: () => time,
    ...options,
  });
  const origin = await listen(
    createServer((request, response) => {
      void gateway.handle(request, response);
    }),
  );
  return {
    origin,
    upstreamOrigin,
    apiKey,
    gateway,
    records,
    advance: (ms) => {
      time += ms;
    },
  };
}

export async function token(origin: string, userId = 'demo-ada'): Promise<string> {
  const response = await fetch(`${origin}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  expect(response.status).toBe(200);
  const value = (await response.json()) as { token: string };
  return value.token;
}

export function completion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'gateway-comment',
    messages: [{ role: 'user', content: 'A practice comment, please.' }],
    metadata: { promptId: 'practice-comment', variables: { tone: 'encouraging' } },
    ...overrides,
  };
}

export async function post(
  origin: string,
  path: string,
  credential: string,
  value: unknown,
  extra: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${credential}`,
      ...extra,
    },
    body: JSON.stringify(value),
  });
}

export function client(
  origin: string,
  credential: string,
  omitAuthorization = false,
): OpenAICompatibleChatModel {
  return openAICompatible({
    baseURL: `${origin}/api/v1`,
    model: 'gateway-comment',
    destination: 'host-server',
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const headers = new Headers(request.headers);
      if (omitAuthorization) headers.delete('authorization');
      const body = (await request.json()) as Record<string, unknown>;
      return fetch(request.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...body, metadata: completion()['metadata'] }),
      });
    },
  })({ credential });
}

export async function answer(instance: HybridInstance, terminal = 'succeeded'): Promise<unknown[]> {
  await instance.prepare();
  const { runId } = await instance.start({});
  await expect.poll(() => instance.getSnapshot().run?.status).toBe('waiting_input');
  const pending = instance.getSnapshot().run?.pending;
  if (pending === undefined) throw new Error('The question did not pause.');
  expect(
    await instance.dispatch({
      ...pending,
      instanceId: instance.instanceId,
      runId,
      action: 'submit',
      payload: { answers: { sum: 'four' } },
    }),
  ).toMatchObject({ status: 'accepted' });
  await expect.poll(() => instance.getSnapshot().run?.status).toBe(terminal);
  const events: unknown[] = [];
  for await (const event of instance.events(runId)) events.push(event);
  return events;
}
