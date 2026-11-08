// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { CapabilityBinding, CapabilityContext } from '@galaxie-ai/core';
import { afterEach, expect, test } from 'vitest';
import { startMcpServer } from '../../../examples/mcp-server/src/index.js';
import { createMcpServer, type McpEvent, type McpLimits, toolPin } from '../src/index.js';

const origin = 'http://127.0.0.1:63315';
const token: string = crypto.randomUUID();
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const context: CapabilityContext = {
  principalScope: 'one' as CapabilityContext['principalScope'],
  signal: new AbortController().signal,
  agent: { id: 'test/limits', version: '1', hash: 'test' },
  runId: 'run' as CapabilityContext['runId'],
  effectId: 'effect' as CapabilityContext['effectId'],
};

async function setup(
  limits: McpLimits,
  custom?: typeof fetch,
): Promise<{
  binding: CapabilityBinding;
  events: McpEvent[];
  server: Awaited<ReturnType<typeof startMcpServer>>;
}> {
  const server = await startMcpServer({
    allowedOrigins: [origin],
    verifyToken: (value) => (value === token ? 'one' : undefined),
  });
  cleanup.push(() => server.close());
  const events: McpEvent[] = [];
  const client = createMcpServer({
    id: 'limits',
    destination: 'user-device',
    url: server.url,
    token: () => token,
    limits,
    onEvent: (event) => {
      events.push(event);
    },
    fetch: (url, init) =>
      (custom ?? fetch)(url, {
        ...init,
        headers: { ...Object.fromEntries(new Headers(init?.headers)), origin },
      }),
  });
  cleanup.push(() => client.close());
  const tool = server.admin.tools().find((tool) => tool.name === 'text.echo');
  if (tool === undefined) throw new Error('Test tool missing.');
  const binding = client.bindings({
    'text.echo': {
      version: 1,
      kind: 'read',
      approval: 'none',
      retry: 'none',
      grantScope: 'principal',
      timeoutMs: 3000,
      concurrency: 1,
      pin: await toolPin(tool),
      result: 'text',
    },
  })['mcp.limits.text.echo@1'] as CapabilityBinding;
  return { binding, events, server };
}

async function limited(call: Promise<unknown>, events: McpEvent[]): Promise<void> {
  const error: unknown = await call.catch((error: unknown) => error);
  expect(error).toMatchObject({
    name: 'GalaxieError',
    code: 'unavailable',
    message: 'The requested service is unavailable.',
  });
  expect(error).not.toHaveProperty('cause');
  expect(events).toContainEqual({ code: 'mcp_limit_exceeded', server: 'limits' });
}

test('cancels an oversized wire body before JSON parsing', async () => {
  let cancelled = false;
  const { binding, events } = await setup({ messageBytes: 2048 }, async (url, init) =>
    String(init?.body).includes('"tools/call"')
      ? new Response(
          new ReadableStream({
            start(controller): void {
              controller.enqueue(new TextEncoder().encode('invalid-json-canary'.repeat(500)));
            },
            cancel(): void {
              cancelled = true;
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        )
      : fetch(url, init),
  );
  await limited(binding.invoke({}, context), events);
  expect(cancelled).toBe(true);
});

test('fails a stalled POST SSE at idleMs instead of the SDK request timeout', async () => {
  let cancelled = false;
  let sentCancel = false;
  const { binding, events } = await setup({ idleMs: 60 }, async (url, init) => {
    if (String(init?.body).includes('"notifications/cancelled"')) sentCancel = true;
    return String(init?.body).includes('"tools/call"')
      ? new Response(
          new ReadableStream({
            cancel(): void {
              cancelled = true;
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      : fetch(url, init);
  });
  const started = performance.now();
  await limited(binding.invoke({}, context), events);
  expect(performance.now() - started).toBeLessThan(700);
  expect(cancelled).toBe(true);
  await expect.poll(() => sentCancel).toBe(true);
});

test('checks canonical result bytes including JSON escaping', async () => {
  const { binding, events } = await setup({ resultBytes: 64 });
  await limited(binding.invoke({ text: '\u0000'.repeat(12) }, context), events);
});

test('counts all listing pages against one wire budget', async () => {
  const { binding, events, server } = await setup({ messageBytes: 1500 }, async (url, init) => {
    if (!String(init?.body).includes('"tools/list"')) return fetch(url, init);
    const request = JSON.parse(String(init?.body)) as { id: number; params?: { cursor?: string } };
    return Response.json({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        tools: [],
        padding: 'x'.repeat(900),
        ...(request.params?.cursor === undefined ? { nextCursor: 'next' } : {}),
      },
    });
  });
  await limited(binding.invoke({}, context), events);
  expect(server.admin.callCount()).toBe(0);
});

test('keeps the standalone GET stream beyond the POST idle deadline', async () => {
  const { binding, events, server } = await setup({ idleMs: 50 });
  expect(await binding.invoke({ text: 'ok' }, context)).toEqual({ text: 'ok' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await server.admin.changeDescription('text.echo', 'changed');
  await expect.poll(() => events.some((event) => event.code === 'mcp_pin_mismatch')).toBe(true);
  expect(events.some((event) => event.code === 'mcp_limit_exceeded')).toBe(false);
});
