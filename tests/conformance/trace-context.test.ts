// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { httpCapability } from '@galaxie-ai/core';
import { createMcpServer, type McpServer } from '@galaxie-ai/tools-mcp';
import { context, propagation, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  StackContextManager,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import { afterAll, afterEach, beforeAll, expect, inject, test } from 'vitest';
import { z } from 'zod';
import {
  binding,
  brokerFixture,
  collect,
  deferred,
} from '../../packages/core/test/fake-executor.js';
import {
  MCP_ORIGIN,
  type McpAction,
  type McpAdminState,
  type McpControl,
  type McpFixture,
} from './support/mcp-context.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  trace.disable();
  context.disable();
  propagation.disable();
});

function tracing(): { provider: TracerProvider; exporter: InMemorySpanExporter } {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  cleanup.push(() => provider.shutdown());
  return { provider, exporter };
}

async function httpRun(provider: TracerProvider): Promise<{
  headers: Headers;
  fixture: Awaited<ReturnType<typeof brokerFixture>>;
}> {
  let headers = new Headers();
  const fixture = await brokerFixture({
    tracerProvider: provider,
    requests: { 'lookup@1': { input: z.object({}), output: z.unknown(), kind: 'read' } },
    bindings: {
      'lookup@1': httpCapability({
        ...binding(),
        destination: 'host-server',
        url: 'https://host.example/lookup',
        method: 'POST',
        propagateTraceContext: true,
        fetch: async (_url, init) => {
          headers = new Headers(init?.headers);
          return Response.json({ ok: true });
        },
      }),
    },
    scripts: [
      async function* ({ capabilities }) {
        await capabilities.call('lookup@1', {});
        yield { type: 'output', output: null };
      },
    ],
  });
  cleanup.push(() => fixture.runtime.dispose());
  return {
    get headers() {
      return headers;
    },
    fixture,
  };
}

test('HTTP backend receives the execute_tool parent in the run trace', async () => {
  const { provider, exporter } = tracing();
  const run = await httpRun(provider);
  const { runId } = await run.fixture.instance.start('input');
  await collect(run.fixture.instance.events(runId));
  expect(run.fixture.scriptErrors).toEqual([]);
  const spans = exporter.getFinishedSpans();
  const root = spans.find((span) => span.name.startsWith('invoke_agent'));
  const tool = spans.find((span) => span.name.startsWith('execute_tool'));
  expect(root).toBeDefined();
  expect(tool).toBeDefined();
  expect(run.headers.get('traceparent')).toBe(
    `00-${root?.spanContext().traceId}-${tool?.spanContext().spanId}-01`,
  );
  expect(tool?.parentSpanContext?.spanId).toBe(root?.spanContext().spanId);
});

// This case needs a global context manager at run start; the browser lane uses explicit contexts.
test.skipIf(typeof window !== 'undefined')(
  'global baggage and custom propagation cannot add outbound headers',
  async () => {
    context.setGlobalContextManager(new StackContextManager().enable());
    propagation.setGlobalPropagator({
      inject(_ctx, carrier, setter): void {
        setter.set(carrier, 'baggage', 'private=value');
        setter.set(carrier, 'x-custom', 'private');
      },
      extract: (ctx) => ctx,
      fields: () => ['baggage', 'x-custom'],
    });
    const { provider } = tracing();
    const run = await httpRun(provider);
    const active = propagation.setBaggage(
      ROOT_CONTEXT,
      propagation.createBaggage({ private: { value: 'value' } }),
    );
    const { runId } = await context.with(active, () => run.fixture.instance.start('input'));
    await collect(run.fixture.instance.events(runId));
    expect(run.fixture.scriptErrors).toEqual([]);
    expect(run.headers.has('traceparent')).toBe(true);
    expect(run.headers.has('baggage')).toBe(false);
    expect(run.headers.has('x-custom')).toBe(false);
  },
);

let mcp: McpFixture;
let local: McpControl | undefined;
let admin: (action: McpAction) => Promise<McpAdminState>;
beforeAll(async () => {
  if (typeof window === 'undefined') {
    const { createFixture } = await import(/* @vite-ignore */ './support/mcp-global.node.js');
    local = await createFixture();
    mcp = local.fixture;
    admin = (action) => local?.admin(action) as Promise<McpAdminState>;
  } else {
    mcp = inject('mcpTrace');
    const { commands } = await import('vitest/browser');
    admin = (action) => commands.mcpTraceAdmin(action);
  }
});
afterAll(async () => {
  await local?.close();
});

test('MCP requests share their call parent and queued list_changed refresh has no trace context', async () => {
  await admin('reset');
  const { provider, exporter } = tracing();
  const entered = deferred<void>();
  const release = deferred<void>();
  const notification = deferred<void>();
  const refreshed = deferred<void>();
  const sent: { method: string; headers: Headers }[] = [];
  const server: McpServer = createMcpServer({
    id: 'trace',
    url: mcp.url,
    destination: 'host-server',
    propagateTraceContext: true,
    token: () => mcp.token,
    fetch: async (url, init) => {
      const method =
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as { method: string }).method
          : (init?.method ?? 'GET');
      const headers = new Headers(init?.headers);
      const recordedHeaders = new Headers(headers);
      sent.push({ method, headers: recordedHeaders });
      // Observe SDK headers before forwarding through the reference server's unchanged CORS policy.
      headers.delete('traceparent');
      headers.delete('tracestate');
      if (typeof window === 'undefined') headers.set('origin', MCP_ORIGIN);
      if (method === 'tools/call') {
        entered.resolve();
        await release.promise;
      }
      const response = await fetch(url, { ...init, headers });
      if (method === 'tools/list' && !recordedHeaders.has('traceparent')) refreshed.resolve();
      if (method !== 'GET' || response.body === null) return response;
      const decoder = new TextDecoder();
      let observed = '';
      return new Response(
        response.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller): void {
              observed += decoder.decode(chunk, { stream: true });
              if (observed.includes('notifications/tools/list_changed')) notification.resolve();
              controller.enqueue(chunk);
            },
          }),
        ),
        { status: response.status, headers: response.headers },
      );
    },
  });
  cleanup.push(() => server.close());
  const fixture = await brokerFixture({
    tracerProvider: provider,
    requests: {
      'mcp.trace.lesson.lookup@1': {
        kind: 'read',
        input: z.object({ lessonId: z.string() }),
        output: z.unknown(),
      },
    },
    bindings: server.bindings({
      'lesson.lookup': {
        version: 1,
        pin: mcp.pins['lesson.lookup'] as string,
        kind: 'read',
        timeoutMs: 3000,
        concurrency: 1,
        grantScope: 'principal',
        retry: 'idempotent',
        approval: 'none',
      },
    }),
    scripts: [
      async function* ({ capabilities }) {
        await capabilities.call('mcp.trace.lesson.lookup@1', { lessonId: 'lesson-1' });
        yield { type: 'output', output: null };
      },
    ],
  });
  cleanup.push(() => fixture.runtime.dispose());
  const { runId } = await fixture.instance.start('input');
  let boundary = 0;
  try {
    await entered.promise;
    await admin('description');
    await notification.promise;
    boundary = sent.length;
  } finally {
    release.resolve();
  }
  await collect(fixture.instance.events(runId));
  expect(fixture.scriptErrors).toEqual([]);
  const tool = exporter.getFinishedSpans().find((span) => span.name.startsWith('execute_tool'));
  const parent = `00-${tool?.spanContext().traceId}-${tool?.spanContext().spanId}-01`;
  for (const method of ['initialize', 'tools/list', 'tools/call', 'GET']) {
    const requests = sent.slice(0, boundary).filter((request) => request.method === method);
    expect(requests.length).toBeGreaterThan(0);
    for (const { headers } of requests) expect(headers.get('traceparent')).toBe(parent);
  }
  await refreshed.promise;
  const refreshes = sent.slice(boundary).filter(({ method }) => method === 'tools/list');
  expect(refreshes.length).toBeGreaterThan(0);
  for (const { headers } of refreshes) expect(headers.has('traceparent')).toBe(false);
});
