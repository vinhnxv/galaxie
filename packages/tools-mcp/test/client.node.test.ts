// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { CapabilityBinding, CapabilityContext } from '@galaxie-ai/core';
import { afterEach, expect, test } from 'vitest';
import { startMcpServer } from '../../../examples/mcp-server/src/index.js';
import { createMcpServer, type McpEvent, toolPin } from '../src/index.js';

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

async function setup(customFetch: typeof fetch = originFetch): Promise<{
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
