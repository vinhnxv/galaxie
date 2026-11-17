// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { type CapabilityBinding, type CapabilityContext, galaxieField } from '@galaxie-ai/core';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { startMcpServer } from '../../../examples/mcp-server/src/index.js';
import {
  brokerFixture,
  collect,
  deferred,
  recordingTracer,
  type Script,
} from '../../core/test/fake-executor.js';
import { createMcpServer, type McpEvent, type McpServerOptions, toolPin } from '../src/index.js';

const origin = 'http://127.0.0.1:63315';
const token: string = crypto.randomUUID();
const other: string = crypto.randomUUID();
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const policy = {
  version: 1,
  kind: 'read' as const,
  timeoutMs: 2000,
  concurrency: 3,
  grantScope: 'principal' as const,
  retry: 'idempotent' as const,
  approval: 'none' as const,
};
function context(principal = 'one', signal = new AbortController().signal): CapabilityContext {
  return {
    principalScope: principal as CapabilityContext['principalScope'],
    agent: { id: 'test/agent', version: '1.0.0', hash: 'test-hash' },
    runId: 'run-1' as CapabilityContext['runId'],
    effectId: 'effect-1' as CapabilityContext['effectId'],
    signal,
  };
}
const originFetch: typeof fetch = (url, init) =>
  fetch(url, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), origin } });

async function setup(
  customFetch: typeof fetch = originFetch,
  overrides: Partial<McpServerOptions> = {},
): Promise<{
  server: Awaited<ReturnType<typeof startMcpServer>>;
  client: ReturnType<typeof createMcpServer>;
  binding: CapabilityBinding;
  events: McpEvent[];
}> {
  const server = await startMcpServer({
    allowedOrigins: [origin],
    verifyToken: (value) => (value === token ? 'one' : value === other ? 'two' : undefined),
  });
  cleanup.push(() => server.close());
  const events: McpEvent[] = [];
  const client = createMcpServer({
    id: 'lessons',
    url: server.url,
    destination: 'user-device',
    token: ({ principalScope }) => (principalScope === 'two' ? other : token),
    fetch: customFetch,
    ...overrides,
    onEvent: (event) => {
      events.push(event);
    },
  });
  cleanup.push(() => client.close());
  const pin = await toolPin(
    server.admin.tools()[0] as ReturnType<typeof server.admin.tools>[number],
  );
  const bindings = client.bindings({ 'lesson.lookup': { ...policy, pin } });
  expect(Object.keys(bindings)).toEqual(['mcp.lessons.lesson.lookup@1']);
  return {
    server,
    client,
    binding: bindings['mcp.lessons.lesson.lookup@1'] as CapabilityBinding,
    events,
  };
}

async function fixed(promise: Promise<unknown>, code = 'unavailable'): Promise<void> {
  const error: unknown = await promise.catch((error: unknown) => error);
  expect(error).toMatchObject({
    name: 'GalaxieError',
    code,
    message:
      code === 'invalid'
        ? 'The request is invalid.'
        : code === 'cancelled'
          ? 'The operation was cancelled.'
          : 'The requested service is unavailable.',
  });
  expect(error).not.toHaveProperty('cause');
  expect(JSON.stringify(error)).not.toContain(token);
}

test('namespaces only allowlisted tools, checks fresh pins, sends protocol and attribution', async () => {
  const { server, binding, events } = await setup();
  expect(await binding.invoke({ lessonId: 'lesson-1' }, context())).toEqual({
    lessonId: 'lesson-1',
    title: 'Practice lesson',
  });
  expect(server.admin.lastHeaders()['mcp-protocol-version']).toBe('2025-11-25');
  expect(server.admin.lastMeta()).toEqual({
    'galaxie.dev/agent': 'test/agent@1.0.0',
    'galaxie.dev/run': 'run-1',
    'galaxie.dev/effect': 'effect-1',
  });
  await server.admin.changeDescription('lesson.lookup', 'private-description-canary');
  await fixed(binding.invoke({ lessonId: 'lesson-1' }, context()));
  expect(server.admin.callCount()).toBe(1);
  expect(events).toContainEqual({
    code: 'mcp_pin_mismatch',
    server: 'lessons',
    tool: 'lesson.lookup',
  });
  expect(JSON.stringify(events)).not.toMatch(/private-description-canary|Practice lesson/);
});

test('isolates principals and closePrincipal discards its session', async () => {
  const { server, client, binding } = await setup();
  await Promise.all(
    ['one', 'two', 'one'].map((principal) =>
      binding.invoke({ lessonId: 'lesson-1' }, context(principal)),
    ),
  );
  expect(server.admin.sessionCount()).toBe(2);
  const before = server.admin.lastHeaders()['mcp-session-id'];
  await client.closePrincipal('one');
  await binding.invoke({ lessonId: 'lesson-1' }, context());
  expect(server.admin.lastHeaders()['mcp-session-id']).not.toBe(before);
});

test.each(['none', 'idempotent', 'idempotency-key'] as const)(
  're-initializes a 404 at most once with retry %s',
  async (retry) => {
    const { server, client, binding, events } = await setup();
    await binding.invoke({ lessonId: 'lesson-1' }, context());
    await server.admin.forgetSessions();
    const pin = await toolPin(
      server.admin.tools()[0] as ReturnType<typeof server.admin.tools>[number],
    );
    const retried = client.bindings({ 'lesson.lookup': { ...policy, pin, retry } })[
      'mcp.lessons.lesson.lookup@1'
    ] as CapabilityBinding;
    if (retry === 'none') await fixed(retried.invoke({ lessonId: 'lesson-1' }, context()));
    else
      expect(await retried.invoke({ lessonId: 'lesson-1' }, context())).toHaveProperty(
        'lessonId',
        'lesson-1',
      );
    expect(events).toContainEqual({
      code: 'mcp_session_reset',
      server: 'lessons',
      tool: 'lesson.lookup',
    });
    expect(server.admin.callCount()).toBe(retry === 'none' ? 1 : 2);
  },
);

test('rejects server sampling with -32601 and emits only method attribution', async () => {
  const { server, binding, events } = await setup();
  server.admin.requestSampling();
  await binding.invoke({ lessonId: 'lesson-1' }, context());
  await expect.poll(() => server.admin.samplingCode()).toBe(-32601);
  expect(events).toContainEqual({
    code: 'mcp_server_request_rejected',
    server: 'lessons',
    method: 'sampling/createMessage',
  });
});

test('projects structured and text results, refuses tool errors and missing structured content', async () => {
  const { server, client, binding, events } = await setup();
  await fixed(binding.invoke({}, context()));
  expect(events).toContainEqual({
    code: 'mcp_tool_error',
    server: 'lessons',
    tool: 'lesson.lookup',
  });
  const pin = await toolPin(
    server.admin.tools().find((tool) => tool.name === 'text.echo') as ReturnType<
      typeof server.admin.tools
    >[number],
  );
  const text = client.bindings({ 'text.echo': { ...policy, pin, result: 'text' } })[
    'mcp.lessons.text.echo@1'
  ] as CapabilityBinding;
  expect(await text.invoke({ text: 'untrusted result' }, context())).toEqual({
    text: 'untrusted result',
  });
  const structured = client.bindings({ 'text.echo': { ...policy, pin } })[
    'mcp.lessons.text.echo@1'
  ] as CapabilityBinding;
  await fixed(structured.invoke({ text: 'untrusted result' }, context()), 'invalid');
});

test('rejects a negotiated protocol mismatch without leaking SDK errors', async () => {
  const rewritten: typeof fetch = async (url, init) => {
    const response = await originFetch(url, init);
    if (String(init?.body).includes('"initialize"'))
      return new Response((await response.text()).replaceAll('2025-11-25', '2025-06-18'), {
        headers: response.headers,
      });
    return response;
  };
  const { binding, events } = await setup(rewritten);
  await fixed(binding.invoke({ lessonId: 'lesson-1' }, context()));
  expect(events).toContainEqual({ code: 'mcp_protocol_mismatch', server: 'lessons' });
});

test.each(['name', 'title', 'description', 'inputSchema', 'outputSchema', 'annotations'] as const)(
  'refuses a changed pinned %s with no tool call',
  async (field) => {
    const rewritten: typeof fetch = async (url, init) => {
      const response = await originFetch(url, init);
      if (!String(init?.body).includes('"tools/list"')) return response;
      return rewrite(response, (message) => {
        const tool = message.result.tools[0];
        if (tool !== undefined)
          tool[field] = field.endsWith('Schema')
            ? { type: 'object', required: ['changed'] }
            : field === 'annotations'
              ? { readOnlyHint: false }
              : 'changed';
      });
    };
    const { binding, server } = await setup(rewritten);
    await fixed(binding.invoke({ lessonId: 'lesson-1' }, context()));
    expect(server.admin.callCount()).toBe(0);
  },
);

async function rewrite(
  response: Response,
  change: (message: { result: { tools: Record<string, unknown>[]; nextCursor?: string } }) => void,
): Promise<Response> {
  const data = (await response.text()).split('\n').find((line) => line.startsWith('data: '));
  const message = JSON.parse(data?.slice(6) ?? '{}') as {
    result: { tools: Record<string, unknown>[]; nextCursor?: string };
  };
  change(message);
  const headers = new Headers(response.headers);
  headers.set('content-type', 'application/json');
  return Response.json(message, { headers });
}

test('ignores an unlisted invalid output schema without compiling it', async () => {
  const { binding } = await setup(async (url, init) => {
    const response = await originFetch(url, init);
    return String(init?.body).includes('"tools/list"')
      ? rewrite(response, (message) => {
          message.result.tools.push({
            name: 'unlisted',
            inputSchema: { type: 'object' },
            outputSchema: { type: 'object', properties: { bad: { type: 'not-a-type' } } },
          });
        })
      : response;
  });
  expect(await binding.invoke({ lessonId: 'lesson-1' }, context())).toHaveProperty(
    'title',
    'Practice lesson',
  );
});

test('rechecks a list_changed notification without a new call', async () => {
  const { binding, server, events } = await setup();
  await binding.invoke({ lessonId: 'lesson-1' }, context());
  await server.admin.changeDescription('lesson.lookup', 'changed metadata');
  await expect.poll(() => events.some((event) => event.code === 'mcp_pin_mismatch')).toBe(true);
  expect(server.admin.callCount()).toBe(1);
});

test('aborts a pending SDK request and sends notifications/cancelled', async () => {
  let pending = false;
  let cancelled = false;
  const { binding } = await setup(async (url, init) => {
    if (String(init?.body).includes('"notifications/cancelled"')) cancelled = true;
    if (String(init?.body).includes('"tools/call"')) {
      pending = true;
      return new Response(new ReadableStream(), {
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    return originFetch(url, init);
  });
  const controller = new AbortController();
  const call = binding.invoke({ lessonId: 'lesson-1' }, context('one', controller.signal));
  await expect.poll(() => pending).toBe(true);
  controller.abort();
  await fixed(call, 'cancelled');
  await expect.poll(() => cancelled).toBe(true);
});

test.each([401, 403, 500])('discards HTTP %s body and uses fresh fixed errors', async (status) => {
  const { binding, events } = await setup(
    async () => new Response('server-error-canary', { status }),
  );
  await fixed(binding.invoke({ lessonId: 'lesson-1' }, context()));
  expect(JSON.stringify(events)).not.toContain('server-error-canary');
  if (status !== 500)
    expect(events).toContainEqual({ code: 'mcp_unauthorized', server: 'lessons' });
});

test('stops after a second 404', async () => {
  let initializations = 0;
  const { binding } = await setup(async (url, init) => {
    if (String(init?.body).includes('"initialize"')) initializations++;
    return String(init?.body).includes('"tools/list"')
      ? new Response(null, { status: 404 })
      : originFetch(url, init);
  });
  await fixed(binding.invoke({ lessonId: 'lesson-1' }, context()));
  expect(initializations).toBe(2);
});

test('caps pagination at ten pages', async () => {
  let pages = 0;
  const { binding, server } = await setup(async (url, init) => {
    const response = await originFetch(url, init);
    return String(init?.body).includes('"tools/list"')
      ? rewrite(response, (message) => {
          pages++;
          message.result.tools = [];
          message.result.nextCursor = String(pages);
        })
      : response;
  });
  await fixed(binding.invoke({ lessonId: 'lesson-1' }, context()));
  expect(pages).toBe(10);
  expect(server.admin.callCount()).toBe(0);
});

test.each([
  { id: 'Bad' },
  { url: 'http://127.0.0.1:1/?' },
  { url: 'http://127.0.0.1:1/#' },
  { url: 'http://user:password@127.0.0.1:1/' },
  { url: 'ftp://127.0.0.1/' },
  { destination: 'in-browser' },
  { token: null },
  { limits: { messageBytes: 0 } },
  { limits: { resultBytes: Infinity } },
  { limits: { idleMs: 0.5 } },
])('validates host configuration at construction: %j', (change) => {
  expect(() =>
    createMcpServer({
      id: 'lessons',
      url: 'http://127.0.0.1:1/',
      destination: 'user-device',
      token: () => token,
      ...change,
    } as Parameters<typeof createMcpServer>[0]),
  ).toThrow('The request is invalid.');
});

test.each([
  { version: 0 },
  { pin: 'ABC' },
  { kind: 'write' },
  { timeoutMs: 0 },
  { concurrency: 0 },
  { result: 'html' },
  { approval: 'other' },
  { retry: 'always' },
])('validates bindings at construction: %j', (change) => {
  const client = createMcpServer({
    id: 'lessons',
    url: 'http://127.0.0.1:1/',
    destination: 'user-device',
    token: () => token,
  });
  expect(() =>
    client.bindings({
      lookup: { ...policy, pin: 'a'.repeat(64), ...change } as Parameters<
        typeof client.bindings
      >[0][string],
    }),
  ).toThrow('The request is invalid.');
});

test.each([undefined, '', 42])(
  'refuses an invalid bearer callback result without sending a request',
  async (value) => {
    let requests = 0;
    const client = createMcpServer({
      id: 'lessons',
      url: 'http://127.0.0.1:1/',
      destination: 'user-device',
      token: (() => value) as unknown as Parameters<typeof createMcpServer>[0]['token'],
      fetch: async () => {
        requests++;
        throw new Error('host-error-canary');
      },
    });
    cleanup.push(() => client.close());
    const binding = client.bindings({ lookup: { ...policy, pin: 'a'.repeat(64) } })[
      'mcp.lessons.lookup@1'
    ] as CapabilityBinding;
    await fixed(binding.invoke({}, context()));
    expect(requests).toBe(0);
  },
);

test.each([undefined, null, true, false])('rejects a non-string namespace %s', (id) => {
  expect(() =>
    createMcpServer({
      id,
      url: 'http://127.0.0.1:1/',
      destination: 'user-device',
      token: () => token,
    } as unknown as Parameters<typeof createMcpServer>[0]),
  ).toThrow('The request is invalid.');
});

test('reconnects on a later independent call after initialize fails', async () => {
  let initializes = 0;
  const { binding, server } = await setup((url, init) => {
    if (String(init?.body).includes('"initialize"') && ++initializes === 1)
      return Promise.resolve(new Response(null, { status: 503 }));
    return originFetch(url, init);
  });
  await fixed(binding.invoke({ lessonId: 'lesson-1' }, context()));
  expect(await binding.invoke({ lessonId: 'lesson-1' }, context())).toHaveProperty(
    'lessonId',
    'lesson-1',
  );
  expect(initializes).toBe(2);
  expect(server.admin.callCount()).toBe(1);
});

test.each(['cancel', 'timeout'] as const)(
  'bounds the initialized notification on %s and releases the principal queue',
  async (mode) => {
    let stalled = false;
    let transportAborted = false;
    const { client, server } = await setup((url, init) => {
      if (!stalled && String(init?.body).includes('"notifications/initialized"')) {
        stalled = true;
        return new Promise<Response>((_resolve, reject) => {
          const abort = (): void => {
            transportAborted = true;
            reject(new Error('Test request aborted.'));
          };
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener('abort', abort, { once: true });
        });
      }
      return originFetch(url, init);
    });
    const tool = server.admin.tools()[0];
    if (tool === undefined) throw new Error('Test tool missing.');
    const binding = client.bindings({
      'lesson.lookup': {
        ...policy,
        timeoutMs: mode === 'timeout' ? 200 : 2000,
        pin: await toolPin(tool),
      },
    })['mcp.lessons.lesson.lookup@1'] as CapabilityBinding;
    const controller = new AbortController();
    const call = binding
      .invoke({ lessonId: 'lesson-1' }, context('one', controller.signal))
      .catch((error: unknown) => error);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await expect.poll(() => stalled).toBe(true);
      if (mode === 'cancel') controller.abort();
      const outcome = await Promise.race([
        call,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve('pending'), 900);
        }),
      ]);
      expect(outcome).toMatchObject({
        name: 'GalaxieError',
        code: mode === 'cancel' ? 'cancelled' : 'timeout',
        message: mode === 'cancel' ? 'The operation was cancelled.' : 'The operation timed out.',
      });
      expect(outcome).not.toHaveProperty('cause');
      expect(transportAborted).toBe(true);
      expect(await binding.invoke({ lessonId: 'lesson-1' }, context())).toHaveProperty(
        'lessonId',
        'lesson-1',
      );
      expect(server.admin.callCount()).toBe(1);
    } finally {
      clearTimeout(timer);
      await client.close();
      await call;
    }
  },
);

test('serializes rotating credentials across each principal listing and dispatch', async () => {
  const server = await startMcpServer({
    allowedOrigins: [origin],
    verifyToken: (value) => (value === token || value === other ? 'one' : undefined),
  });
  cleanup.push(() => server.close());
  let credentials = 0;
  let recording = false;
  let releaseDispatch: () => void = () => {};
  const dispatchGate = new Promise<void>((resolve) => {
    releaseDispatch = resolve;
  });
  let held = false;
  const sent: Array<{ method: string; credential: string }> = [];
  const client = createMcpServer({
    id: 'rotation',
    url: server.url,
    destination: 'user-device',
    token: () => {
      credentials++;
      return credentials <= 3 ? token : other;
    },
    fetch: async (url, init) => {
      const body =
        typeof init?.body === 'string' ? (JSON.parse(init.body) as { method?: string }) : {};
      if (recording && (body.method === 'tools/list' || body.method === 'tools/call')) {
        const authorization = new Headers(init?.headers).get('authorization');
        sent.push({
          method: body.method,
          credential:
            authorization === `Bearer ${token}`
              ? 'first'
              : authorization === `Bearer ${other}`
                ? 'second'
                : 'invalid',
        });
        if (body.method === 'tools/call' && !held) {
          held = true;
          await dispatchGate;
        }
      }
      return originFetch(url, init);
    },
  });
  cleanup.push(() => client.close());
  const tool = server.admin.tools()[0];
  if (tool === undefined) throw new Error('Test tool missing.');
  const binding = client.bindings({ 'lesson.lookup': { ...policy, pin: await toolPin(tool) } })[
    'mcp.rotation.lesson.lookup@1'
  ] as CapabilityBinding;
  await binding.invoke({ lessonId: 'lesson-1' }, context());
  recording = true;
  const first = binding.invoke({ lessonId: 'lesson-1' }, context());
  await expect.poll(() => held).toBe(true);
  const second = binding.invoke({ lessonId: 'lesson-1' }, context());
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(credentials).toBe(3);
  } finally {
    releaseDispatch();
  }
  await Promise.all([first, second]);
  expect(sent).toEqual([
    { method: 'tools/list', credential: 'first' },
    { method: 'tools/call', credential: 'first' },
    { method: 'tools/list', credential: 'second' },
    { method: 'tools/call', credential: 'second' },
  ]);
});

interface RecordedRequest {
  readonly method: string;
  readonly headers: Headers;
}

async function traceFixture(
  bound: CapabilityBinding,
  script: Script,
): Promise<{
  fixture: Awaited<ReturnType<typeof brokerFixture>>;
  exporter: ReturnType<typeof recordingTracer>['exporter'];
}> {
  const { provider, exporter } = recordingTracer();
  cleanup.push(() => provider.shutdown());
  const fixture = await brokerFixture({
    tracerProvider: provider,
    input: z.string().meta(galaxieField({ label: 'public' })),
    bindings: { 'mcp.lessons.lesson.lookup@1': bound },
    requests: {
      'mcp.lessons.lesson.lookup@1': {
        kind: 'read',
        input: z.object({ lessonId: z.enum(['lesson-1']) }),
        output: z.unknown(),
      },
    },
    scripts: [script],
  });
  cleanup.push(() => fixture.runtime.dispose());
  return { fixture, exporter };
}

function recordRequest(sent: RecordedRequest[], init: RequestInit | undefined): string {
  const method =
    typeof init?.body === 'string'
      ? ((JSON.parse(init.body) as { method?: string }).method ?? init?.method ?? 'GET')
      : (init?.method ?? 'GET');
  sent.push({ method, headers: new Headers(init?.headers) });
  return method;
}

test.each([true, false])(
  'MCP trace context is scoped to each broker call when opted in: %s',
  async (enabled) => {
    const sent: RecordedRequest[] = [];
    const { binding, client } = await setup(
      (url, init) => {
        recordRequest(sent, init);
        return originFetch(url, init);
      },
      { destination: 'host-server', ...(enabled ? { propagateTraceContext: true } : {}) },
    );
    const boundaries: number[] = [];
    const { fixture, exporter } = await traceFixture(binding, async function* ({ capabilities }) {
      for (let call = 0; call < 2; call++) {
        expect(
          await capabilities.call('mcp.lessons.lesson.lookup@1', { lessonId: 'lesson-1' }),
        ).toHaveProperty('lessonId', 'lesson-1');
        boundaries.push(sent.length);
      }
      yield { type: 'output', output: null };
    });
    const { runId } = await fixture.instance.start('input');
    await collect(fixture.instance.events(runId));
    expect(fixture.scriptErrors).toEqual([]);
    const spans = exporter.getFinishedSpans();
    const root = spans.find((span) => span.name.startsWith('invoke_agent'));
    const calls = spans.filter((span) => span.name.startsWith('execute_tool'));
    expect(calls).toHaveLength(2);
    expect(sent.map(({ method }) => method)).toEqual(
      expect.arrayContaining(['initialize', 'tools/list', 'tools/call', 'GET']),
    );
    const first = sent.slice(0, boundaries[0]);
    const second = sent.slice(boundaries[0], boundaries[1]);
    for (const [index, requests] of [first, second].entries()) {
      const expected = enabled
        ? `00-${root?.spanContext().traceId}-${calls[index]?.spanContext().spanId}-01`
        : null;
      expect(requests.length).toBeGreaterThan(1);
      for (const { headers } of requests) {
        expect(headers.get('traceparent')).toBe(expected);
        expect(headers.has('tracestate')).toBe(false);
        expect(headers.has('baggage')).toBe(false);
      }
    }
    expect(calls[0]?.spanContext().spanId).not.toBe(calls[1]?.spanContext().spanId);
    const beforeClose = sent.length;
    await client.closePrincipal('test-user');
    await client.close();
    expect(sent.slice(beforeClose).every(({ headers }) => !headers.has('traceparent'))).toBe(true);
  },
);

test('a list_changed refresh queued during a broker call carries no settled trace context', async () => {
  const sent: RecordedRequest[] = [];
  const entered = deferred<void>();
  const release = deferred<void>();
  const notification = deferred<void>();
  const { binding, server } = await setup(
    async (url, init) => {
      const method = recordRequest(sent, init);
      if (method === 'tools/call') {
        entered.resolve();
        await release.promise;
      }
      const response = await originFetch(url, init);
      if (method !== 'GET' || response.body === null) return response;
      const decoder = new TextDecoder();
      let observed = '';
      const stream = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller): void {
            observed += decoder.decode(chunk, { stream: true });
            if (observed.includes('notifications/tools/list_changed')) notification.resolve();
            controller.enqueue(chunk);
          },
        }),
      );
      return new Response(stream, { status: response.status, headers: response.headers });
    },
    { destination: 'host-server', propagateTraceContext: true },
  );
  const { fixture } = await traceFixture(binding, async function* ({ capabilities }) {
    await capabilities.call('mcp.lessons.lesson.lookup@1', { lessonId: 'lesson-1' });
    yield { type: 'output', output: null };
  });
  const { runId } = await fixture.instance.start('input');
  await entered.promise;
  expect(sent.find(({ method }) => method === 'tools/call')?.headers.has('traceparent')).toBe(true);
  const before = sent.length;
  await server.admin.changeDescription('lesson.lookup', 'changed metadata');
  await notification.promise;
  expect(sent.slice(before).filter(({ method }) => method === 'tools/list')).toHaveLength(0);
  release.resolve();
  await collect(fixture.instance.events(runId));
  expect(fixture.scriptErrors).toEqual([]);
  await expect
    .poll(() => sent.slice(before).filter(({ method }) => method === 'tools/list').length)
    .toBe(1);
  const refresh = sent.slice(before).find(({ method }) => method === 'tools/list');
  expect(refresh?.headers.has('traceparent')).toBe(false);
  expect(refresh?.headers.has('tracestate')).toBe(false);
});

test('the standalone SSE stream keeps its opening call parent while a later run reuses the session', async () => {
  const sent: RecordedRequest[] = [];
  const opened = deferred<void>();
  const entered = deferred<void>();
  const release = deferred<void>();
  const notifications = [deferred<void>(), deferred<void>()];
  const refreshed = deferred<void>();
  const streams: { headers: Headers; notifications: number }[] = [];
  let calls = 0;
  const { binding, server } = await setup(
    async (url, init) => {
      const method = recordRequest(sent, init);
      if (method === 'tools/call') {
        await opened.promise;
        if (++calls === 2) {
          entered.resolve();
          await release.promise;
        }
      }
      const response = await originFetch(url, init);
      // Resolve on any refresh so a leaked header fails the assertion, not a timeout.
      if (method === 'tools/list') refreshed.resolve();
      if (method !== 'GET' || response.body === null) return response;
      const stream = { headers: new Headers(init?.headers), notifications: 0 };
      streams.push(stream);
      const decoder = new TextDecoder();
      let observed = '';
      const body = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller): void {
            observed += decoder.decode(chunk, { stream: true });
            const count = [...observed.matchAll(/notifications\/tools\/list_changed/g)].length;
            while (stream.notifications < count) notifications[stream.notifications++]?.resolve();
            controller.enqueue(chunk);
          },
        }),
      );
      opened.resolve();
      return new Response(body, { status: response.status, headers: response.headers });
    },
    { destination: 'host-server', propagateTraceContext: true },
  );
  const script: Script = async function* ({ capabilities }) {
    await capabilities.call('mcp.lessons.lesson.lookup@1', { lessonId: 'lesson-1' });
    yield { type: 'output', output: null };
  };
  const first = await traceFixture(binding, script);
  const { runId: firstRun } = await first.fixture.instance.start('input');
  expect((await collect(first.fixture.instance.events(firstRun))).at(-1)).toMatchObject({
    type: 'output',
  });
  expect(first.fixture.scriptErrors).toEqual([]);
  const firstCall = first.exporter
    .getFinishedSpans()
    .find((span) => span.name.startsWith('execute_tool'));
  const firstParent = `00-${firstCall?.spanContext().traceId}-${firstCall?.spanContext().spanId}-01`;
  expect(streams).toHaveLength(1);
  expect(streams[0]?.headers.get('traceparent')).toBe(firstParent);
  await server.admin.changeDescription('lesson.lookup', 'Look up a lesson.');
  await notifications[0]?.promise;
  await refreshed.promise;

  const boundary = sent.length;
  const second = await traceFixture(binding, script);
  const { runId: secondRun } = await second.fixture.instance.start('input');
  try {
    await entered.promise;
    await server.admin.changeDescription('lesson.lookup', 'Look up a lesson.');
    await notifications[1]?.promise;
    // docs/guides/tracing.md: the first GET parents the stream for its whole life.
    expect(streams).toHaveLength(1);
    expect(streams[0]?.notifications).toBe(2);
    expect(streams[0]?.headers.get('traceparent')).toBe(firstParent);
  } finally {
    release.resolve();
  }
  expect((await collect(second.fixture.instance.events(secondRun))).at(-1)).toMatchObject({
    type: 'output',
  });
  expect(second.fixture.scriptErrors).toEqual([]);
  const secondCall = second.exporter
    .getFinishedSpans()
    .find((span) => span.name.startsWith('execute_tool'));
  const secondParent = `00-${secondCall?.spanContext().traceId}-${secondCall?.spanContext().spanId}-01`;
  expect(secondParent).not.toBe(firstParent);
  const requests = sent.slice(boundary).filter(({ method }) => method === 'tools/call');
  expect(requests).toHaveLength(1);
  expect(requests[0]?.headers.get('traceparent')).toBe(secondParent);
  expect(requests[0]?.headers.get('mcp-session-id')).toBe(
    streams[0]?.headers.get('mcp-session-id'),
  );
  expect(sent.filter(({ method }) => method === 'initialize')).toHaveLength(1);
  expect(sent.filter(({ method }) => method === 'GET')).toHaveLength(1);
});

test('a 404 reconnect within one invoke retains its call parent and clears it after settlement', async () => {
  const sent: RecordedRequest[] = [];
  const refreshed = deferred<void>();
  let rejected = false;
  const { binding, client, events, server } = await setup(
    async (url, init) => {
      const method = recordRequest(sent, init);
      if (method === 'tools/call' && !rejected) {
        rejected = true;
        return new Response(null, { status: 404 });
      }
      const response = await originFetch(url, init);
      if (method === 'tools/list' && !new Headers(init?.headers).has('traceparent'))
        refreshed.resolve();
      return response;
    },
    { destination: 'host-server', propagateTraceContext: true },
  );
  const { fixture, exporter } = await traceFixture(binding, async function* ({ capabilities }) {
    expect(
      await capabilities.call('mcp.lessons.lesson.lookup@1', { lessonId: 'lesson-1' }),
    ).toHaveProperty('lessonId', 'lesson-1');
    yield { type: 'output', output: null };
  });
  const { runId } = await fixture.instance.start('input');
  expect((await collect(fixture.instance.events(runId))).at(-1)).toMatchObject({ type: 'output' });
  expect(fixture.scriptErrors).toEqual([]);
  expect(events.filter(({ code }) => code === 'mcp_session_reset')).toHaveLength(1);
  const tool = exporter.getFinishedSpans().find((span) => span.name.startsWith('execute_tool'));
  const parent = `00-${tool?.spanContext().traceId}-${tool?.spanContext().spanId}-01`;
  for (const method of ['initialize', 'GET', 'tools/call'])
    expect(sent.filter((request) => request.method === method)).toHaveLength(2);
  expect(server.admin.callCount()).toBe(1);
  const calls = sent.filter(({ method }) => method === 'tools/call');
  expect(calls[0]?.headers.get('mcp-session-id')).not.toBe(calls[1]?.headers.get('mcp-session-id'));
  for (const { headers } of sent) {
    expect(headers.get('traceparent')).toBe(parent);
    expect(headers.has('tracestate')).toBe(false);
    expect(headers.has('baggage')).toBe(false);
  }
  const boundary = sent.length;
  await server.admin.changeDescription('lesson.lookup', 'Look up a lesson.');
  await refreshed.promise;
  await client.closePrincipal('test-user');
  const settled = sent.slice(boundary);
  expect(settled.some(({ method }) => method === 'tools/list')).toBe(true);
  for (const { headers } of settled) {
    expect(headers.has('traceparent')).toBe(false);
    expect(headers.has('tracestate')).toBe(false);
    expect(headers.has('baggage')).toBe(false);
  }
});

test.each(['error', 'abort'] as const)(
  'clears MCP trace context after a broker call %s',
  async (mode) => {
    const sent: RecordedRequest[] = [];
    const entered = deferred<void>();
    const controller = new AbortController();
    let first = true;
    const { binding } = await setup(
      async (url, init) => {
        const method = recordRequest(sent, init);
        if (method === 'tools/call' && first) {
          first = false;
          entered.resolve();
          if (mode === 'error') return new Response(null, { status: 503 });
          return new Promise<Response>((_resolve, reject) => {
            const abort = (): void => reject(new Error('Test request aborted.'));
            if (init?.signal?.aborted) abort();
            else init?.signal?.addEventListener('abort', abort, { once: true });
          });
        }
        return originFetch(url, init);
      },
      { destination: 'host-server', propagateTraceContext: true },
    );
    const { fixture } = await traceFixture(binding, async function* ({ capabilities }) {
      await expect(
        capabilities.call(
          'mcp.lessons.lesson.lookup@1',
          { lessonId: 'lesson-1' },
          { signal: controller.signal },
        ),
      ).rejects.toMatchObject({ code: mode === 'error' ? 'unavailable' : 'cancelled' });
      yield { type: 'output', output: null };
    });
    const { runId } = await fixture.instance.start('input');
    await entered.promise;
    if (mode === 'abort') controller.abort();
    await collect(fixture.instance.events(runId));
    expect(fixture.scriptErrors).toEqual([]);
    expect(sent.find(({ method }) => method === 'tools/call')?.headers.has('traceparent')).toBe(
      true,
    );
    const before = sent.length;
    expect(await binding.invoke({ lessonId: 'lesson-1' }, context('test-user'))).toHaveProperty(
      'lessonId',
      'lesson-1',
    );
    expect(sent.slice(before).length).toBeGreaterThan(0);
    for (const { headers } of sent.slice(before)) {
      expect(headers.has('traceparent')).toBe(false);
      expect(headers.has('tracestate')).toBe(false);
    }
  },
);

test.each(['closePrincipal', 'close'] as const)(
  'clears the in-flight context before %s aborts the transport',
  async (method) => {
    const sent: RecordedRequest[] = [];
    const entered = deferred<void>();
    const { binding, client } = await setup(
      async (url, init) => {
        if (recordRequest(sent, init) === 'tools/call') {
          entered.resolve();
          return new Promise<Response>((_resolve, reject) => {
            const abort = (): void => reject(new Error('Test request aborted.'));
            if (init?.signal?.aborted) abort();
            else init?.signal?.addEventListener('abort', abort, { once: true });
          });
        }
        return originFetch(url, init);
      },
      { destination: 'host-server', propagateTraceContext: true },
    );
    const { fixture } = await traceFixture(binding, async function* ({ capabilities }) {
      await expect(
        capabilities.call('mcp.lessons.lesson.lookup@1', { lessonId: 'lesson-1' }),
      ).rejects.toMatchObject({ code: 'cancelled' });
      yield { type: 'output', output: null };
    });
    const { runId } = await fixture.instance.start('input');
    await entered.promise;
    expect(sent.find(({ method }) => method === 'tools/call')?.headers.has('traceparent')).toBe(
      true,
    );
    const before = sent.length;
    if (method === 'closePrincipal') await client.closePrincipal('test-user');
    else await client.close();
    await collect(fixture.instance.events(runId));
    expect(fixture.scriptErrors).toEqual([]);
    expect(
      sent
        .slice(before)
        .every(({ headers }) => !headers.has('traceparent') && !headers.has('tracestate')),
    ).toBe(true);
  },
);

test('does not propagate from an MCP binding copied to a non-host destination', async () => {
  const sent: RecordedRequest[] = [];
  const { binding } = await setup(
    (url, init) => {
      recordRequest(sent, init);
      return originFetch(url, init);
    },
    { destination: 'host-server', propagateTraceContext: true },
  );
  const { fixture } = await traceFixture(
    { ...binding, destination: 'third-party' },
    async function* ({ capabilities }) {
      await capabilities.call('mcp.lessons.lesson.lookup@1', { lessonId: 'lesson-1' });
      yield { type: 'output', output: null };
    },
  );
  const { runId } = await fixture.instance.start('input');
  await collect(fixture.instance.events(runId));
  expect(fixture.scriptErrors).toEqual([]);
  expect(sent.length).toBeGreaterThan(0);
  expect(
    sent.every(({ headers }) => !headers.has('traceparent') && !headers.has('tracestate')),
  ).toBe(true);
});

test.each(['in-browser', 'user-device', 'user-endpoint', 'third-party'] as const)(
  'rejects trace context opt-in for an MCP %s destination',
  (destination) => {
    expect(() =>
      createMcpServer({
        id: 'lessons',
        url: 'http://127.0.0.1:1/',
        destination,
        token: () => token,
        propagateTraceContext: true,
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid' }));
  },
);

test.each(['yes', null, 1])('rejects a non-boolean MCP trace context option: %j', (value) => {
  expect(() =>
    createMcpServer({
      id: 'lessons',
      url: 'http://127.0.0.1:1/',
      destination: 'host-server',
      token: () => token,
      propagateTraceContext: value as unknown as boolean,
    }),
  ).toThrow(expect.objectContaining({ code: 'invalid' }));
});
