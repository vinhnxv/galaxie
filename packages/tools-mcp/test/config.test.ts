// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  type AgentDefinition,
  type CapabilityBinding,
  type CapabilityContext,
  GalaxieError,
  galaxieField,
} from '@galaxie-ai/core';
import {
  buildHostConfig,
  type HostConfigDocument,
  HostConfigError,
  type HostConfigHooks,
  validateHostConfig,
} from '@galaxie-ai/core/config';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { startMcpServer } from '../../../examples/mcp-server/src/index.js';
import { brokerFixture, collect, recordingTracer } from '../../core/test/fake-executor.js';
import {
  type BuiltMcpServers,
  buildMcpServers,
  createMcpServer,
  type McpEvent,
  type McpServer,
  type McpServerOptions,
  toolPin,
} from '../src/index.js';

vi.mock('../src/server.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/server.js')>();
  return { ...actual, createMcpServer: vi.fn(actual.createMcpServer) };
});
const { createMcpServer: realCreateMcpServer } =
  await vi.importActual<typeof import('../src/server.js')>('../src/server.js');
const factory = vi.mocked(createMcpServer);
const created: McpServer[] = [];
beforeEach(() => {
  created.length = 0;
  factory.mockReset().mockImplementation((options) => {
    const server = realCreateMcpServer(options);
    created.push(server);
    return server;
  });
});

const origin = 'http://127.0.0.1:63315';
const tokenValue = crypto.randomUUID();
const secondToken = crypto.randomUUID();
const inputSchema = z.string().meta(galaxieField({ label: 'public' }));
const lookupRequest = {
  kind: 'read',
  input: z.object({ lessonId: z.enum(['lesson-1']) }),
  output: z.object({ lessonId: z.literal('lesson-1'), title: z.literal('Practice lesson') }),
} as const;
const requests = {
  'mcp.lessons.lesson.lookup@1': lookupRequest,
  'mcp.lessons.progress.record@1': { kind: 'write', input: z.unknown(), output: z.unknown() },
  'mcp.lessons.text.echo@1': { kind: 'read', input: z.unknown(), output: z.unknown() },
  'lessons.get@1': lookupRequest,
  'mcp.school.other@1': lookupRequest,
} as const;
const definition: AgentDefinition = {
  id: 'tests/config',
  version: '1.0.0',
  executor: 'fake',
  input: inputSchema,
  capabilities: { optional: requests },
};
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function context(principal = 'test-user'): CapabilityContext {
  return {
    principalScope: principal as CapabilityContext['principalScope'],
    agent: { id: 'tests/config', version: '1.0.0', hash: '' },
    runId: 'run-1' as CapabilityContext['runId'],
    effectId: 'effect-1' as CapabilityContext['effectId'],
    signal: new AbortController().signal,
  };
}

async function endpoint() {
  const server = await startMcpServer({
    allowedOrigins: [origin],
    verifyToken: (value) =>
      value === tokenValue ? 'test-user' : value === secondToken ? 'second-user' : undefined,
  });
  cleanup.push(() => server.close());
  const pins = Object.fromEntries(
    await Promise.all(server.admin.tools().map(async (tool) => [tool.name, await toolPin(tool)])),
  );
  const sent: { method: string; headers: Headers }[] = [];
  const transport = vi.fn<typeof fetch>(async (url, init) => {
    if (typeof init?.body === 'string') {
      const body = JSON.parse(init.body) as { method?: string; id?: unknown };
      if (body.method !== undefined && body.id !== undefined)
        sent.push({ method: body.method, headers: new Headers(init.headers) });
    }
    const headers = new Headers(init?.headers);
    headers.set('origin', origin);
    headers.set('x-config-header-canary', 'header-value-canary');
    return fetch(url, { ...init, headers });
  });
  const token = vi.fn(({ principalScope }: { principalScope: string; signal: AbortSignal }) =>
    principalScope === 'second-user' ? secondToken : tokenValue,
  );
  const hooks = { token: { lessonToken: token }, fetch: { transport } };
  return { server, pins, sent, token, transport, hooks };
}

function document(url: string, pins: Record<string, string>) {
  return {
    version: '0.1' as const,
    mcp: {
      servers: {
        lessons: {
          url,
          destination: 'host-server' as const,
          token: 'lessonToken',
          fetch: 'transport',
          tools: {
            'lesson.lookup': {
              version: 1,
              pin: pins['lesson.lookup'] as string,
              kind: 'read' as const,
              timeoutMs: 2000,
              concurrency: 3,
              grantScope: 'principal' as const,
              retry: 'idempotent' as const,
              approval: 'none' as const,
            },
            'progress.record': {
              version: 1,
              pin: pins['progress.record'] as string,
              kind: 'write' as const,
              timeoutMs: 4000,
              concurrency: 1,
              grantScope: 'run' as const,
              retry: 'idempotency-key' as const,
              approval: 'confirm' as const,
            },
          },
        },
      },
    },
  };
}

function handBuilt(fixture: Awaited<ReturnType<typeof endpoint>>) {
  const server = realCreateMcpServer({
    id: 'lessons',
    url: fixture.server.url,
    destination: 'host-server',
    token: fixture.hooks.token.lessonToken,
    fetch: fixture.hooks.fetch.transport,
  });
  cleanup.push(() => server.close());
  const bindings = server.bindings({
    'lesson.lookup': {
      version: 1,
      pin: fixture.pins['lesson.lookup'] as string,
      kind: 'read',
      timeoutMs: 2000,
      concurrency: 3,
      grantScope: 'principal',
      retry: 'idempotent',
      approval: 'none',
    },
    'progress.record': {
      version: 1,
      pin: fixture.pins['progress.record'] as string,
      kind: 'write',
      timeoutMs: 4000,
      concurrency: 1,
      grantScope: 'run',
      retry: 'idempotency-key',
      approval: 'confirm',
    },
  });
  return { server, bindings };
}

function lookup(bindings: Readonly<Record<string, CapabilityBinding>>): CapabilityBinding {
  const binding = bindings['mcp.lessons.lesson.lookup@1'];
  if (binding === undefined) throw new Error('Missing test binding.');
  return binding;
}

function build(
  config: ReturnType<typeof validateHostConfig>,
  options?: { onEvent?: (event: McpEvent) => void },
): BuiltMcpServers {
  const built = buildMcpServers(config, options);
  cleanup.push(async () => {
    await Promise.all(Object.values(built.servers).map((server) => server.close()));
  });
  return built;
}

const canaries = [
  'value-free-host.invalid',
  tokenValue,
  secondToken,
  'x-config-header-canary',
  'header-value-canary',
];
function assertValueFree(error: HostConfigError): void {
  const serialized = JSON.stringify([
    error,
    error.cause,
    error.path,
    error.message,
    error.cause instanceof Error ? error.cause.message : undefined,
  ]);
  for (const value of canaries) expect(serialized).not.toContain(value);
}
function rejected(
  action: () => unknown,
  path: string,
  code: 'invalid' | 'unsupported' = 'invalid',
): HostConfigError {
  let error: unknown;
  try {
    action();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(HostConfigError);
  const failure = error as HostConfigError;
  expect(failure).toMatchObject({
    code,
    path,
    message:
      code === 'invalid' ? 'The request is invalid.' : 'The requested feature is unsupported.',
  });
  if (failure.cause !== undefined)
    expect(failure.cause).toMatchObject({ code, message: 'The request is invalid.' });
  assertValueFree(failure);
  return failure;
}

test('T-equal: matches hand-built pinned names, policies and endpoint requests', async () => {
  const fixture = await endpoint();
  const hand = handBuilt(fixture);
  const config = validateHostConfig(
    document('/mcp', fixture.pins),
    definition,
    fixture.hooks,
    fixture.server.url,
  );
  const built = build(config);
  expect(Object.keys(built.bindings)).toEqual([
    'mcp.lessons.lesson.lookup@1',
    'mcp.lessons.progress.record@1',
  ]);
  expect(Object.keys(hand.bindings)).toEqual([
    'mcp.lessons.lesson.lookup@1',
    'mcp.lessons.progress.record@1',
  ]);
  for (const name of Object.keys(hand.bindings)) {
    const { invoke: handInvoke, ...handPolicy } = hand.bindings[
      name as keyof typeof hand.bindings
    ] as CapabilityBinding;
    const { invoke, ...policy } = built.bindings[
      name as keyof typeof built.bindings
    ] as CapabilityBinding;
    expect(
      Reflect.ownKeys(built.bindings[name as keyof typeof built.bindings] as CapabilityBinding),
    ).toEqual(
      Reflect.ownKeys(hand.bindings[name as keyof typeof hand.bindings] as CapabilityBinding),
    );
    expect(policy).toEqual(handPolicy);
    expect(invoke).toBeTypeOf('function');
    expect(handInvoke).toBeTypeOf('function');
    expect(Object.isFrozen(built.bindings[name as keyof typeof built.bindings])).toBe(true);
    expect(Object.isFrozen(hand.bindings[name as keyof typeof hand.bindings])).toBe(true);
  }
  expect(Object.getPrototypeOf(built.bindings)).toBeNull();
  expect(Object.isFrozen(built.bindings)).toBe(true);
  expect(Object.isFrozen(built.servers)).toBe(true);
  expect(Object.keys(built.servers)).toEqual(['lessons']);
  expect(await lookup(hand.bindings).invoke({ lessonId: 'lesson-1' }, context())).toEqual({
    lessonId: 'lesson-1',
    title: 'Practice lesson',
  });
  expect(fixture.sent.map(({ method }) => method)).toEqual([
    'initialize',
    'tools/list',
    'tools/list',
    'tools/call',
  ]);
  fixture.sent.length = 0;
  expect(await lookup(built.bindings).invoke({ lessonId: 'lesson-1' }, context())).toEqual({
    lessonId: 'lesson-1',
    title: 'Practice lesson',
  });
  expect(fixture.sent.map(({ method }) => method)).toEqual([
    'initialize',
    'tools/list',
    'tools/list',
    'tools/call',
  ]);
});

test('T-integration: merges code bindings and routes principal tokens through the runtime', async () => {
  const oracle = await endpoint();
  const hand = handBuilt(oracle);
  await lookup(hand.bindings).invoke({ lessonId: 'lesson-1' }, context());
  await lookup(hand.bindings).invoke({ lessonId: 'lesson-1' }, context('second-user'));
  expect(oracle.server.admin.callCount()).toBe(2);
  await hand.server.closePrincipal('test-user');
  const expectedSessions = oracle.server.admin.sessionCount();
  expect(expectedSessions).toBe(2);
  const fixture = await endpoint();
  const httpFetch = vi.fn<typeof fetch>(async () =>
    Response.json({ lessonId: 'lesson-1', title: 'Practice lesson' }),
  );
  const data = {
    ...document(fixture.server.url, fixture.pins),
    capabilities: {
      'lessons.get@1': {
        kind: 'read',
        url: '/api/lessons/{lessonId}',
        method: 'GET',
        destination: 'host-server',
        fetch: 'http',
        timeoutMs: 2000,
        concurrency: 1,
        grantScope: 'principal',
        retry: 'idempotent',
        approval: 'none',
      },
    },
  };
  const config = validateHostConfig(
    data,
    definition,
    { ...fixture.hooks, fetch: { ...fixture.hooks.fetch, http: httpFetch } },
    fixture.server.url,
  );
  const mcp = build(config);
  const merged = buildHostConfig(config, mcp.bindings);
  expect(Object.keys(merged.bindings)).toEqual([
    'mcp.lessons.lesson.lookup@1',
    'mcp.lessons.progress.record@1',
    'lessons.get@1',
  ]);
  const script: import('../../core/test/fake-executor.js').Script = async function* ({
    capabilities,
  }) {
    expect(await capabilities.call('lessons.get@1', { lessonId: 'lesson-1' })).toEqual({
      lessonId: 'lesson-1',
      title: 'Practice lesson',
    });
    const output = await capabilities.call('mcp.lessons.lesson.lookup@1', { lessonId: 'lesson-1' });
    expect(output).toEqual({ lessonId: 'lesson-1', title: 'Practice lesson' });
    yield { type: 'output', output };
  };
  const broker = await brokerFixture({
    input: inputSchema,
    requests,
    // The fixture erases input types; the broker still validates the shared request schemas.
    bindings: merged.bindings as Readonly<Record<string, CapabilityBinding>>,
    scripts: [script, script],
  });
  cleanup.push(() => broker.runtime.dispose());
  const { runId } = await broker.instance.start('input');
  await collect(broker.instance.events(runId));
  const second = await broker.runtime.create(definition, {
    principalScope: 'second-user',
    agent: {},
    bindings: merged.bindings,
  });
  await second.prepare();
  const secondRun = await second.start('input');
  await collect(second.events(secondRun.runId));
  expect(broker.scriptErrors).toEqual([]);
  expect(fixture.server.admin.callCount()).toBe(2);
  expect(fixture.token).toHaveBeenCalledWith({
    principalScope: 'test-user',
    signal: expect.any(AbortSignal),
  });
  expect(fixture.token).toHaveBeenCalledWith({
    principalScope: 'second-user',
    signal: expect.any(AbortSignal),
  });
  expect(
    fixture.sent
      .filter(({ method }) => method === 'tools/call')
      .map(({ headers }) => headers.get('authorization')),
  ).toEqual([`Bearer ${tokenValue}`, `Bearer ${secondToken}`]);
  expect(httpFetch).toHaveBeenCalledWith(
    new URL('/api/lessons/lesson-1', fixture.server.url).href,
    expect.objectContaining({ method: 'GET', redirect: 'error' }),
  );
  await mcp.servers['lessons']?.closePrincipal('test-user');
  expect(fixture.server.admin.sessionCount()).toBe(expectedSessions);
  const sentBefore = fixture.transport.mock.calls.length;
  await lookup(mcp.bindings).invoke({ lessonId: 'lesson-1' }, context('second-user'));
  expect(fixture.sent.filter(({ method }) => method === 'initialize')).toHaveLength(2);
  expect(fixture.sent.filter(({ method }) => method === 'tools/call')).toHaveLength(3);
  expect(fixture.transport.mock.calls.length).toBeGreaterThan(sentBefore);
});

test('characterizes the known fractional timeout divergence before building', async () => {
  const fixture = await endpoint();
  const data = document(fixture.server.url, fixture.pins);
  data.mcp.servers.lessons.tools['lesson.lookup'].timeoutMs = 1.5;
  expect(() => validateHostConfig(data, definition, fixture.hooks, origin)).not.toThrow();
  const hand = handBuilt(fixture);
  expect(() =>
    hand.server.bindings({
      'lesson.lookup': { ...data.mcp.servers.lessons.tools['lesson.lookup'] },
    }),
  ).toThrow('The request is invalid.');
  expect(() =>
    hand.server.bindings({
      'lesson.lookup': { ...data.mcp.servers.lessons.tools['lesson.lookup'], timeoutMs: 2 },
    }),
  ).not.toThrow();
});

test.each([true, false])(
  'T-options: trace propagation matches hand-built broker calls (%s)',
  async (enabled) => {
    for (const wiring of ['hand', 'document'] as const) {
      const fixture = await endpoint();
      const { provider, exporter } = recordingTracer();
      cleanup.push(() => provider.shutdown());
      const data: HostConfigDocument = {
        version: '0.1',
        mcp: {
          servers: {
            lessons: {
              ...document(fixture.server.url, fixture.pins).mcp.servers.lessons,
              propagateTraceContext: enabled,
            },
          },
        },
      };
      const options: McpServerOptions = {
        id: 'lessons',
        url: fixture.server.url,
        destination: 'host-server',
        token: fixture.token,
        fetch: fixture.transport,
        propagateTraceContext: enabled,
      };
      let bindings: Readonly<Record<string, CapabilityBinding>>;
      if (wiring === 'hand') {
        const server = realCreateMcpServer(options);
        cleanup.push(() => server.close());
        bindings = server.bindings({
          'lesson.lookup': {
            version: 1,
            pin: fixture.pins['lesson.lookup'] as string,
            kind: 'read',
            timeoutMs: 2000,
            concurrency: 3,
            grantScope: 'principal',
            retry: 'idempotent',
            approval: 'none',
          },
        });
      } else {
        bindings = build(validateHostConfig(data, definition, fixture.hooks, origin)).bindings;
      }
      const broker = await brokerFixture({
        tracerProvider: provider,
        input: inputSchema,
        requests,
        bindings,
        scripts: [
          async function* ({ capabilities }) {
            expect(
              await capabilities.call('mcp.lessons.lesson.lookup@1', { lessonId: 'lesson-1' }),
            ).toEqual({ lessonId: 'lesson-1', title: 'Practice lesson' });
            yield { type: 'output', output: null };
          },
        ],
      });
      cleanup.push(() => broker.runtime.dispose());
      const { runId } = await broker.instance.start('input');
      await collect(broker.instance.events(runId));
      expect(broker.scriptErrors).toEqual([]);
      const span = exporter.getFinishedSpans().find((span) => span.name.startsWith('execute_tool'));
      expect(span).toBeDefined();
      const parent = enabled
        ? `00-${span?.spanContext().traceId}-${span?.spanContext().spanId}-01`
        : null;
      expect(fixture.sent.map(({ headers }) => headers.get('traceparent'))).toEqual([
        parent,
        parent,
        parent,
        parent,
      ]);
    }
  },
);

test('T-options: custom result limit and text mode match a hand-built server', async () => {
  for (const wiring of ['hand', 'document'] as const) {
    const fixture = await endpoint();
    const events: McpEvent[] = [];
    const onEvent = (event: McpEvent): void => {
      events.push(event);
    };
    const entry = {
      version: 1,
      pin: fixture.pins['text.echo'] as string,
      kind: 'read' as const,
      timeoutMs: 2000,
      concurrency: 1,
      grantScope: 'principal' as const,
      retry: 'none' as const,
      approval: 'none' as const,
      result: 'text' as const,
    };
    let bindings: Readonly<Record<string, CapabilityBinding>>;
    if (wiring === 'hand') {
      const server = realCreateMcpServer({
        id: 'lessons',
        url: fixture.server.url,
        destination: 'host-server',
        token: fixture.token,
        fetch: fixture.transport,
        limits: { messageBytes: 100000, resultBytes: 64, idleMs: 2000 },
        onEvent,
      });
      cleanup.push(() => server.close());
      bindings = server.bindings({ 'text.echo': entry });
    } else {
      const data = {
        version: '0.1',
        mcp: {
          servers: {
            lessons: {
              url: fixture.server.url,
              destination: 'host-server',
              token: 'lessonToken',
              fetch: 'transport',
              limits: { messageBytes: 100000, resultBytes: 64, idleMs: 2000 },
              tools: { 'text.echo': entry },
            },
          },
        },
      };
      bindings = build(validateHostConfig(data, definition, fixture.hooks, origin), {
        onEvent,
      }).bindings;
    }
    const binding = bindings['mcp.lessons.text.echo@1'] as CapabilityBinding;
    expect(await binding.invoke({ text: 'hello' }, context())).toEqual({ text: 'hello' });
    await expect(binding.invoke({ text: '\u0000'.repeat(12) }, context())).rejects.toMatchObject({
      code: 'unavailable',
      message: 'The requested service is unavailable.',
    });
    expect(events).toContainEqual({ code: 'mcp_limit_exceeded', server: 'lessons' });
  }
});

test('T-events: passes the host callback the document server id on a changed pin', async () => {
  const fixture = await endpoint();
  const onEvent = vi.fn<(event: McpEvent) => void>();
  const built = build(
    validateHostConfig(
      document(fixture.server.url, fixture.pins),
      definition,
      fixture.hooks,
      origin,
    ),
    { onEvent },
  );
  await lookup(built.bindings).invoke({ lessonId: 'lesson-1' }, context());
  expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ code: 'mcp_pin_mismatch' }));
  await fixture.server.admin.changeDescription('lesson.lookup', 'Changed tool description.');
  await expect(
    lookup(built.bindings).invoke({ lessonId: 'lesson-1' }, context()),
  ).rejects.toMatchObject({
    code: 'unavailable',
    message: 'The requested service is unavailable.',
  });
  expect(onEvent).toHaveBeenCalledWith({
    code: 'mcp_pin_mismatch',
    server: 'lessons',
    tool: 'lesson.lookup',
  });
  expect(fixture.server.admin.callCount()).toBe(1);
});

test.each(['token', 'fetch', 'inherited-token', 'inherited-fetch'] as const)(
  'T-no-server: refuses a missing or inherited %s hook before construction',
  async (missing) => {
    const fixture = await endpoint();
    const data = document(fixture.server.url, fixture.pins);
    const group = missing.endsWith('fetch') ? 'fetch' : 'token';
    const hooks: HostConfigHooks = {
      ...fixture.hooks,
      [group]: missing.startsWith('inherited') ? Object.create(fixture.hooks[group]) : {},
    };
    rejected(
      () => build(validateHostConfig(data, definition, hooks, origin)),
      `/mcp/servers/lessons/${group}`,
    );
    expect(factory).not.toHaveBeenCalled();
    expect(fixture.transport).not.toHaveBeenCalled();
    expect(fixture.server.admin.sessionCount()).toBe(0);
    build(validateHostConfig(data, definition, fixture.hooks, origin));
    expect(factory).toHaveBeenCalledTimes(1);
  },
);

test('T-forged: rejects reconstructed and spread configurations before creating servers', async () => {
  const fixture = await endpoint();
  const config = validateHostConfig(
    document(fixture.server.url, fixture.pins),
    definition,
    fixture.hooks,
    origin,
  );
  for (const forged of [{ document: config.document, hooks: config.hooks }, { ...config }]) {
    expect(rejected(() => build(forged), '').cause).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
  }
  build(config);
  expect(factory).toHaveBeenCalledTimes(1);
});

test('T-no-effects: validation and building invoke no hook or I/O; hooks retain call identity', async () => {
  const fixture = await endpoint();
  const data = document(fixture.server.url, fixture.pins);
  data.mcp.servers.lessons.token = 'toString';
  data.mcp.servers.lessons.fetch = 'valueOf';
  const hooks = {
    token: Object.defineProperty({}, 'toString', { value: fixture.token }),
    fetch: Object.defineProperty({}, 'valueOf', { value: fixture.transport }),
  };
  const config = validateHostConfig(data, definition, hooks, origin);
  expect(fixture.token).not.toHaveBeenCalled();
  expect(fixture.transport).not.toHaveBeenCalled();
  const built = build(config);
  expect(fixture.token).not.toHaveBeenCalled();
  expect(fixture.transport).not.toHaveBeenCalled();
  expect(fixture.server.admin.sessionCount()).toBe(0);
  await lookup(built.bindings).invoke({ lessonId: 'lesson-1' }, context());
  expect(fixture.token).toHaveBeenCalledWith({
    principalScope: 'test-user',
    signal: expect.any(AbortSignal),
  });
  expect(fixture.transport).toHaveBeenCalled();
});

test('T-server-reject: retains the real factory error and server path', async () => {
  const fixture = await endpoint();
  const data = document(fixture.server.url, fixture.pins);
  const config = validateHostConfig(
    {
      ...data,
      mcp: {
        servers: {
          first: { ...data.mcp.servers.lessons, tools: {} },
          second: { ...data.mcp.servers.lessons, tools: {} },
        },
      },
    },
    definition,
    fixture.hooks,
    origin,
  );
  let original: unknown;
  factory.mockImplementation((options) => {
    try {
      const server = realCreateMcpServer({
        ...options,
        ...(options.id === 'second'
          ? { url: 'https://value-free-host.invalid/mcp?header-value-canary' }
          : {}),
      });
      created.push(server);
      return server;
    } catch (error) {
      original = error;
      throw error;
    }
  });
  const error = rejected(() => build(config), '/mcp/servers/second');
  expect(original).toBeInstanceOf(GalaxieError);
  expect(error.cause).toBe(original);
  factory.mockImplementation(realCreateMcpServer);
  expect(Object.keys(build(config).servers)).toEqual(['first', 'second']);
});

test('T-tool-reject: wraps the known fractional timeout divergence at the tool path', async () => {
  const fixture = await endpoint();
  const data = document(fixture.server.url, fixture.pins);
  data.mcp.servers.lessons.tools['lesson.lookup'].timeoutMs = 1.5;
  const config = validateHostConfig(data, definition, fixture.hooks, origin);
  let original: unknown;
  factory.mockImplementation((options) => {
    const server = realCreateMcpServer(options);
    created.push(server);
    return {
      ...server,
      bindings: (tools) => {
        try {
          return server.bindings(tools);
        } catch (error) {
          original = error;
          throw error;
        }
      },
    };
  });
  expect(rejected(() => build(config), '/mcp/servers/lessons/tools/lesson.lookup').cause).toBe(
    original,
  );
  expect(original).toBeInstanceOf(GalaxieError);
  data.mcp.servers.lessons.tools['lesson.lookup'].timeoutMs = 2;
  build(validateHostConfig(data, definition, fixture.hooks, origin));
});

test.each([
  new Error(`value-free-host.invalid ${tokenValue} x-config-header-canary`),
  'header-value-canary',
])('T-tool-reject: discards an untyped factory failure without a cause (%#)', async (thrown) => {
  const fixture = await endpoint();
  const config = validateHostConfig(
    document(fixture.server.url, fixture.pins),
    definition,
    fixture.hooks,
    origin,
  );
  factory.mockImplementationOnce(() => {
    throw thrown;
  });
  expect(rejected(() => build(config), '/mcp/servers/lessons').cause).toBeUndefined();
  build(config);
});

test.each(['factory', 'tool'] as const)(
  'T-rollback: closes every retained server on a third-server %s failure',
  async (failure) => {
    const fixture = await endpoint();
    const data = document(fixture.server.url, fixture.pins);
    const server = data.mcp.servers.lessons;
    if (failure === 'tool') server.tools['progress.record'].timeoutMs = 1.5;
    const config = validateHostConfig(
      {
        ...data,
        mcp: {
          servers: {
            first: { ...server, tools: {} },
            second: { ...server, tools: {} },
            lessons: server,
          },
        },
      },
      definition,
      fixture.hooks,
      origin,
    );
    factory.mockImplementation((options) => {
      const client = realCreateMcpServer({
        ...options,
        ...(failure === 'factory' && options.id === 'lessons'
          ? { url: `${fixture.server.url}?rejected` }
          : {}),
      });
      expect(() => client.bindings({})).not.toThrow();
      created.push(client);
      return client;
    });
    let result: BuiltMcpServers | undefined;
    rejected(
      () => {
        result = build(config);
      },
      failure === 'factory' ? '/mcp/servers/lessons' : '/mcp/servers/lessons/tools/progress.record',
    );
    expect(result).toBeUndefined();
    expect(created).toHaveLength(failure === 'factory' ? 2 : 3);
    for (const client of created)
      expect(() => client.bindings({})).toThrow('The request is invalid.');
    factory.mockImplementation(realCreateMcpServer);
    const fixed = { ...server, tools: {} };
    expect(
      Object.keys(
        build(
          validateHostConfig(
            { version: '0.1', mcp: { servers: { first: fixed, second: fixed, lessons: fixed } } },
            definition,
            fixture.hooks,
            origin,
          ),
        ).servers,
      ),
    ).toEqual(['first', 'second', 'lessons']);
  },
);

test.each([
  ['query', { url: 'https://value-free-host.invalid/mcp?q=1' }, '/mcp/servers/lessons'],
  ['fragment', { url: 'https://value-free-host.invalid/mcp#part' }, '/mcp/servers/lessons'],
  [
    'userinfo',
    { url: 'https://user:placeholder@value-free-host.invalid/mcp' },
    '/mcp/servers/lessons',
  ],
  ['in-browser', { destination: 'in-browser' }, '/mcp/servers/lessons'],
  [
    'non-loopback device',
    { url: 'https://value-free-host.invalid/mcp', destination: 'user-device' },
    '/mcp/servers/lessons',
  ],
  [
    'third-party trace',
    { destination: 'third-party', propagateTraceContext: true },
    '/mcp/servers/lessons',
  ],
  ['zero limit', { limits: { idleMs: 0 } }, '/mcp/servers/lessons'],
  ['negative limit', { limits: { messageBytes: -1 } }, '/mcp/servers/lessons'],
  ['fractional limit', { limits: { resultBytes: 1.5 } }, '/mcp/servers/lessons'],
  ['non-loopback HTTP', { url: 'http://value-free-host.invalid/mcp' }, '/mcp/servers/lessons'],
] as const)(
  'T-parity: core and the factory refuse %s with an accepted control',
  async (_label, change, path) => {
    const fixture = await endpoint();
    const data = document(fixture.server.url, fixture.pins);
    const base = data.mcp.servers.lessons;
    rejected(
      () =>
        validateHostConfig(
          { ...data, mcp: { servers: { lessons: { ...base, ...change } } } },
          definition,
          fixture.hooks,
          origin,
        ),
      path,
    );
    expect(() =>
      realCreateMcpServer({
        id: 'lessons',
        url: fixture.server.url,
        destination: 'host-server',
        token: fixture.token,
        ...change,
      }),
    ).toThrow('The request is invalid.');
    for (const accepted of [
      { destination: 'user-device' as const },
      { destination: 'host-server' as const, propagateTraceContext: true },
    ]) {
      expect(() =>
        validateHostConfig(
          { ...data, mcp: { servers: { lessons: { ...base, ...accepted } } } },
          definition,
          fixture.hooks,
          origin,
        ),
      ).not.toThrow();
      const client = realCreateMcpServer({
        id: 'lessons',
        url: fixture.server.url,
        token: fixture.token,
        ...accepted,
      });
      cleanup.push(() => client.close());
    }
  },
);

test('T-collision: rejects reserved HTTP names before construction and duplicate code names at build', async () => {
  const fixture = await endpoint();
  const data = document(fixture.server.url, fixture.pins);
  const http = {
    kind: 'read',
    url: '/api/lesson',
    method: 'GET',
    destination: 'host-server',
    timeoutMs: 1000,
    concurrency: 1,
    grantScope: 'run',
    retry: 'none',
    approval: 'none',
  } as const;
  rejected(
    () =>
      build(
        validateHostConfig(
          { ...data, capabilities: { 'mcp.school.other@1': http } },
          definition,
          fixture.hooks,
          origin,
        ),
      ),
    '/capabilities/mcp.school.other@1',
  );
  expect(factory).not.toHaveBeenCalled();
  const config = validateHostConfig(
    { ...data, capabilities: { 'lessons.get@1': http } },
    definition,
    fixture.hooks,
    origin,
  );
  const mcp = build(config);
  rejected(
    () => buildHostConfig(config, { ...mcp.bindings, 'lessons.get@1': lookup(mcp.bindings) }),
    '/capabilities/lessons.get@1',
  );
  expect(Object.keys(buildHostConfig(config, mcp.bindings).bindings)).toContain('lessons.get@1');
});

test('T-value-free: the error canary check detects leakage in messages, causes and paths', () => {
  assertValueFree(new HostConfigError('invalid', '/mcp/servers/lessons'));
  for (const value of canaries) {
    expect(() => assertValueFree(new HostConfigError('invalid', value))).toThrow();
    expect(() =>
      assertValueFree(new HostConfigError('invalid', '', new GalaxieError('invalid', value))),
    ).toThrow();
    const leaky = new HostConfigError('invalid', '');
    leaky.message = value;
    expect(() => assertValueFree(leaky)).toThrow();
  }
});

test('T-host-close: the host closes locally like a hand-built server without reconnecting', async () => {
  const oracle = await endpoint();
  const hand = handBuilt(oracle);
  await lookup(hand.bindings).invoke({ lessonId: 'lesson-1' }, context());
  await hand.server.close();
  const expectedSessions = oracle.server.admin.sessionCount();
  expect(expectedSessions).toBe(1);
  const oracleRequests = oracle.transport.mock.calls.length;
  const unavailable = { code: 'unavailable', message: 'The requested service is unavailable.' };
  await expect(
    lookup(hand.bindings).invoke({ lessonId: 'lesson-1' }, context()),
  ).rejects.toMatchObject(unavailable);
  expect(oracle.transport).toHaveBeenCalledTimes(oracleRequests);
  const fixture = await endpoint();
  const built = build(
    validateHostConfig(
      document(fixture.server.url, fixture.pins),
      definition,
      fixture.hooks,
      origin,
    ),
  );
  await lookup(built.bindings).invoke({ lessonId: 'lesson-1' }, context());
  expect(fixture.server.admin.sessionCount()).toBe(1);
  await Promise.all(Object.values(built.servers).map((server) => server.close()));
  expect(fixture.server.admin.sessionCount()).toBe(expectedSessions);
  const requestsBefore = fixture.transport.mock.calls.length;
  await expect(
    lookup(built.bindings).invoke({ lessonId: 'lesson-1' }, context()),
  ).rejects.toMatchObject(unavailable);
  expect(fixture.transport).toHaveBeenCalledTimes(requestsBefore);
  expect(fixture.sent.filter(({ method }) => method === 'initialize')).toHaveLength(1);
  expect(fixture.server.admin.callCount()).toBe(1);
});

test.each([{ version: '0.1' }, { version: '0.1', mcp: { servers: {} } }])(
  'T-empty: returns frozen empty maps without constructing a server (%#)',
  (data) => {
    const config = validateHostConfig(data, definition, {}, origin);
    const built = build(config);
    expect(Object.keys(built.bindings)).toEqual([]);
    expect(Object.keys(built.servers)).toEqual([]);
    expect(Object.isFrozen(built.bindings)).toBe(true);
    expect(Object.isFrozen(built.servers)).toBe(true);
    rejected(() => build({ ...config }), '');
    expect(factory).not.toHaveBeenCalled();
  },
);

test.each([
  ['non-function onEvent with servers', 5, true],
  ['non-function onEvent without servers', 5, false],
  ['null options', null, true],
])(
  'T-options: %s is refused at the document root, not a server entry',
  async (_label, bad, withServer) => {
    const fixture = await endpoint();
    const config = withServer
      ? validateHostConfig(
          document(fixture.server.url, fixture.pins),
          definition,
          fixture.hooks,
          origin,
        )
      : validateHostConfig({ version: '0.1' }, definition, {}, origin);
    const options = bad === null ? null : { onEvent: bad };
    rejected(() => buildMcpServers(config, options as never), '');
    expect(build(config, { onEvent: () => {} })).toBeDefined();
  },
);

test('T-immutable: detached frozen configuration and hooks keep their original behavior', async () => {
  const fixture = await endpoint();
  const data = document(fixture.server.url, fixture.pins);
  const config = validateHostConfig(data, definition, fixture.hooks, origin);
  data.mcp.servers.lessons.url = 'https://value-free-host.invalid/mcp';
  data.mcp.servers.lessons.tools['lesson.lookup'].timeoutMs = 1.5;
  fixture.hooks.token.lessonToken = vi.fn(() => secondToken);
  fixture.hooks.fetch.transport = vi.fn(async () => {
    throw new Error('Changed hook must not run.');
  });
  expect(Object.isFrozen(config.document.mcp?.servers['lessons']?.tools)).toBe(true);
  expect(() =>
    Object.assign(config.document.mcp?.servers['lessons'] ?? {}, {
      url: data.mcp.servers.lessons.url,
    }),
  ).toThrow(TypeError);
  const built = build(config);
  expect(() => Object.assign(built.bindings, { changed: {} })).toThrow(TypeError);
  expect(lookup(built.bindings).timeoutMs).toBe(2000);
  expect(await lookup(built.bindings).invoke({ lessonId: 'lesson-1' }, context())).toEqual({
    lessonId: 'lesson-1',
    title: 'Practice lesson',
  });
  expect(fixture.hooks.token.lessonToken).not.toHaveBeenCalled();
  expect(fixture.hooks.fetch.transport).not.toHaveBeenCalled();
});
