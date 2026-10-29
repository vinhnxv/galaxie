// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { createLangGraphAdapter } from '@galaxie/adapter-langgraph';
import {
  type CapabilityBinding,
  type CapabilityRequests,
  createRuntime,
  type DiagnosticEvent,
  defineAgentDefinition,
} from '@galaxie/core';
import { createMcpServer, type McpEvent, type McpLimits, type McpServer } from '@galaxie/tools-mcp';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph/web';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import { afterAll, afterEach, beforeAll, beforeEach, expect, inject, test } from 'vitest';
import { z } from 'zod';
import { collect } from '../../packages/core/test/fake-executor.js';
import {
  MCP_ORIGIN,
  type McpAction,
  type McpAdminState,
  type McpFixture,
} from './support/mcp-context.js';
import type { McpControl } from './support/mcp-global.node.js';

let fixture: McpFixture;
let local: McpControl | undefined;
let admin: (action: McpAction) => Promise<McpAdminState>;
const clients: McpServer[] = [];
beforeAll(async () => {
  if (typeof window === 'undefined') {
    const { createFixture } = await import(/* @vite-ignore */ './support/mcp-global.node.js');
    local = await createFixture();
    fixture = local.fixture;
    admin = (action) => local?.admin(action) as Promise<McpAdminState>;
  } else {
    fixture = inject('mcp');
    const { commands } = await import('vitest/browser');
    admin = (action) => commands.mcpAdmin(action);
    expect(location.origin).toBe(MCP_ORIGIN);
  }
});
beforeEach(async () => {
  await admin('reset');
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});
afterAll(async () => {
  await local?.close();
});

const policy = {
  version: 1,
  kind: 'read' as const,
  timeoutMs: 2000,
  concurrency: 2,
  grantScope: 'principal' as const,
  approval: 'none' as const,
  retry: 'idempotent' as const,
};
function client(
  limits?: McpLimits,
  url?: string,
): { client: McpServer; bindings: Record<string, CapabilityBinding>; events: McpEvent[] } {
  const events: McpEvent[] = [];
  const instance = createMcpServer({
    id: 'lessons',
    url: url ?? fixture.url,
    destination: 'user-device',
    token: ({ principalScope }) => (principalScope === 'two' ? fixture.otherToken : fixture.token),
    ...(limits === undefined ? {} : { limits }),
    fetch: (url, init) =>
      fetch(
        url,
        typeof window === 'undefined'
          ? {
              ...init,
              headers: { ...Object.fromEntries(new Headers(init?.headers)), origin: MCP_ORIGIN },
            }
          : init,
      ),
    onEvent: (event) => {
      events.push(event);
    },
  });
  clients.push(instance);
  return {
    client: instance,
    events,
    bindings: instance.bindings({
      'lesson.lookup': { ...policy, pin: fixture.pins['lesson.lookup'] as string },
      'text.echo': { ...policy, pin: fixture.pins['text.echo'] as string, result: 'text' },
      'progress.record': {
        ...policy,
        kind: 'write',
        approval: 'confirm',
        pin: fixture.pins['progress.record'] as string,
      },
    }),
  };
}

const requests: CapabilityRequests = {
  'mcp.lessons.lesson.lookup@1': {
    kind: 'read',
    input: z.object({ lessonId: z.enum(['lesson-1']) }),
    output: z.object({ lessonId: z.string(), title: z.string() }),
  },
  'mcp.lessons.text.echo@1': {
    kind: 'read',
    input: z.object({ size: z.number().int().min(0).max(100000) }),
    output: z.object({ text: z.string() }),
  },
  'mcp.lessons.progress.record@1': {
    kind: 'write',
    input: z.object({ lessonId: z.enum(['lesson-1']) }),
    output: z.object({ count: z.number() }),
  },
  'mcp.lessons.unlisted@1': { kind: 'read', input: z.object({}), output: z.unknown() },
};
async function run(
  bindings: Record<string, CapabilityBinding>,
  name = 'mcp.lessons.lesson.lookup@1',
  principal = 'one',
  input: unknown = { lessonId: 'lesson-1' },
): Promise<{
  answer: unknown;
  error: unknown;
  diagnostics: DiagnosticEvent[];
  events: unknown[];
  spans: unknown[];
  snapshot: unknown;
}> {
  let answer: unknown;
  let error: unknown;
  const diagnostics: DiagnosticEvent[] = [];
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  const runtime = createRuntime({
    appId: 'mcp-conformance',
    executors: [createLangGraphAdapter()],
    tracerProvider: provider,
    diagnostics: (event) => {
      diagnostics.push(event);
    },
  });
  const definition = defineAgentDefinition({
    id: 'conformance/mcp',
    version: '1.0.0',
    executor: 'langgraph-js',
    input: z.object({}),
    capabilities: { optional: requests },
  });
  const instance = await runtime.create(definition, {
    principalScope: principal,
    bindings,
    agent: (host) =>
      new StateGraph(Annotation.Root({ done: Annotation<boolean> }))
        .addNode('call', async (_state, config) => {
          try {
            answer = await host.capabilities.call(name as keyof typeof bindings, input, config);
          } catch (caught) {
            error = caught;
            throw caught;
          }
          return { done: true };
        })
        .addEdge(START, 'call')
        .addEdge('call', END)
        .compile(),
  });
  try {
    await instance.prepare();
    const { runId } = await instance.start({});
    const events = await collect(instance.events(runId));
    await provider.forceFlush();
    return {
      answer,
      error,
      diagnostics,
      events,
      spans: exporter
        .getFinishedSpans()
        .map((span) => ({ attributes: span.attributes, events: span.events, status: span.status })),
      snapshot: instance.getSnapshot(),
    };
  } finally {
    await runtime.dispose();
    await provider.shutdown();
  }
}

test('AT-25 namespaces allowlisted capabilities and denies an unlisted tool', async () => {
  const { bindings } = client();
  expect(Object.keys(bindings)).toEqual([
    'mcp.lessons.lesson.lookup@1',
    'mcp.lessons.text.echo@1',
    'mcp.lessons.progress.record@1',
  ]);
  const result = await run(bindings);
  expect(result.answer).toEqual({ lessonId: 'lesson-1', title: 'Practice lesson' });
  const before = await admin('state');
  expect((await run(bindings, 'mcp.lessons.unlisted@1', 'one', {})).error).toMatchObject({
    code: 'denied',
  });
  expect((await admin('state')).calls).toBe(before.calls);
});

test('AT-25 disables changed metadata without disclosing it through events or diagnostics', async () => {
  const { bindings, events } = client();
  await run(bindings);
  const before = await admin('state');
  await admin('description');
  const result = await run(bindings);
  expect(result.error).toMatchObject({ code: 'unavailable' });
  expect(result.error).not.toHaveProperty('cause');
  expect((await admin('state')).calls).toBe(before.calls);
  expect(events.some((event) => event.code === 'mcp_pin_mismatch')).toBe(true);
  expect(
    JSON.stringify([
      events,
      result.diagnostics.map((event) => String(event.error)),
      result.events,
      result.spans,
      result.snapshot,
      String(result.error),
    ]),
  ).not.toMatch(/metadata-canary|Look up a lesson|Practice lesson/);
  expect(
    JSON.stringify([
      events,
      result.diagnostics.map((event) => String(event.error)),
      result.events,
      result.spans,
      result.snapshot,
      String(result.error),
    ]),
  ).not.toContain(fixture.token);
});

test('AT-25 limits MCP results through the broker', async () => {
  const { bindings, events } = client({ resultBytes: 64 });
  expect(
    (await run(bindings, 'mcp.lessons.text.echo@1', 'one', { size: 100 })).error,
  ).toMatchObject({ code: 'unavailable' });
  expect(events.some((event) => event.code === 'mcp_limit_exceeded')).toBe(true);
});

test('AT-33 re-initializes a forgotten session and sends the protocol header', async () => {
  const { bindings, events } = client();
  await run(bindings);
  const first = (await admin('state')).headers['mcp-session-id'];
  await admin('forget');
  expect((await run(bindings)).answer).toHaveProperty('lessonId', 'lesson-1');
  const state = await admin('state');
  expect(state.headers['mcp-session-id']).not.toBe(first);
  expect(state.headers['mcp-protocol-version']).toBe('2025-11-25');
  expect(events.some((event) => event.code === 'mcp_session_reset')).toBe(true);
});

test('AT-33 keeps sessions separate across principals and closes a signed-out principal', async () => {
  const { bindings, client: server } = client();
  await run(bindings);
  const first = (await admin('state')).headers['mcp-session-id'];
  await run(bindings, 'mcp.lessons.lesson.lookup@1', 'two');
  expect((await admin('state')).headers['mcp-session-id']).not.toBe(first);
  expect((await admin('state')).sessions).toBe(2);
  await server.closePrincipal('one');
  await run(bindings);
  expect((await admin('state')).headers['mcp-session-id']).not.toBe(first);
});

test('AT-33 rejects sampling on the call SSE stream', async () => {
  const { bindings, events } = client();
  await admin('sampling');
  expect((await run(bindings)).error).toBeUndefined();
  await expect.poll(async () => (await admin('state')).samplingCode).toBe(-32601);
  expect(events).toContainEqual({
    code: 'mcp_server_request_rejected',
    server: 'lessons',
    method: 'sampling/createMessage',
  });
});

test('AT-33 rejects a bad Origin with 403; browsers observe the CORS failure', async () => {
  expect((await admin('bad-origin')).badOriginStatus).toBe(403);
  const { bindings } = client(undefined, fixture.badUrl);
  expect((await run(bindings)).error).toMatchObject({ code: 'unavailable' });
});

test('write confirmations remain unsupported and never reach the server', async () => {
  const { bindings } = client();
  const before = await admin('state');
  expect((await run(bindings, 'mcp.lessons.progress.record@1')).error).toMatchObject({
    code: 'unsupported',
  });
  const after = await admin('state');
  expect(after.calls).toBe(before.calls);
  expect(after.counters).toEqual(before.counters);
});
