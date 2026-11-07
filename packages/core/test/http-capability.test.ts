// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import {
  attributionHeaders,
  type CapabilityBinding,
  type CapabilityContext,
  galaxieField,
  type HttpCapabilityOptions,
  httpCapability,
  type Schema,
} from '../src/index.js';
import { binding, brokerFixture, collect } from './fake-executor.js';

const values = [
  'https://evil.example',
  '../admin',
  '../admin?x=1',
  'a/b',
  '?x=1',
  '#f',
  '.',
  '..',
  '',
  '%2e',
  '%2E%2e',
];
const inputSchema = z.object({ id: z.enum(values) });

test.each([
  ['http://localhost/x/{id}', 'user-device', 'unreachable'],
  ['http://127.0.0.1/x/{id}', 'user-endpoint', 'unreachable'],
  ['https://192.168.1.1/x/{id}', 'user-endpoint', 'unreachable'],
  ['https://model.local/x/{id}', 'user-endpoint', 'unreachable'],
  ['https://[::ffff:192.168.1.1]/x/{id}', 'user-endpoint', 'unreachable'],
  ['https://api.example/x/{id}', 'user-endpoint', 'unavailable'],
  ['http://localhost/x/{id}', 'host-server', 'unavailable'],
] as const)(
  'maps only user-endpoint transport failures for %s (%s)',
  async (url, destination, code) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError(`transport-marker ${url}`);
    });
    const result = await call(httpCapability(options({ url, destination, fetch })), inputSchema, {
      id: 'a/b',
    });
    expect(result.error).toMatchObject({ code });
    expect(result.error).not.toHaveProperty('cause');
    expect(result.publicFields).not.toContain('transport-marker');
    expect(result.publicFields).not.toContain(new URL(url).hostname);
  },
);

test.each(['TimeoutError', 'AbortError'])(
  'preserves unavailable for an independent host fetch %s',
  async (name) => {
    const result = await call(
      httpCapability(
        options({
          url: 'http://localhost/x/{id}',
          destination: 'user-device',
          fetch: async (_url, init) => {
            expect(init?.signal?.aborted).toBe(false);
            throw new DOMException('transport-error-marker', name);
          },
        }),
      ),
      inputSchema,
      { id: 'a/b' },
    );
    expect(result.error).toMatchObject({ code: 'unavailable' });
    expect(result.error).not.toHaveProperty('cause');
    expect(result.publicFields).not.toContain('transport-error-marker');
  },
);

test.each(['user-device', 'host-server'] as const)(
  'uses a copied binding destination of %s for network failure classification',
  async (destination) => {
    const original = httpCapability(
      options({
        url: 'http://localhost/x/{id}',
        destination: destination === 'user-device' ? 'host-server' : 'user-device',
        fetch: async () => {
          throw new TypeError('transport-marker');
        },
      }),
    );
    const result = await call({ ...original, destination }, inputSchema, { id: 'a/b' });
    expect(result.error).toMatchObject({
      code: destination === 'user-device' ? 'unreachable' : 'unavailable',
    });
  },
);
function options(overrides: Partial<HttpCapabilityOptions> = {}): HttpCapabilityOptions {
  return {
    ...binding(),
    destination: 'host-server',
    url: 'https://api.example.test/lessons/{id}',
    method: 'GET',
    ...overrides,
  };
}
async function call(
  bound: CapabilityBinding,
  schema: Schema,
  input: unknown,
  payloadBytes?: number,
): Promise<{ value: unknown; error: unknown; publicFields: string }> {
  let value: unknown;
  let error: unknown;
  const fixture = await brokerFixture({
    input: z.string().meta(galaxieField({ label: 'public' })),
    requests: { 'http@1': { input: schema, output: z.unknown(), kind: bound.kind } },
    bindings: { 'http@1': bound },
    ...(payloadBytes === undefined ? {} : { budgets: { payloadBytes } }),
    scripts: [
      async function* ({ capabilities }) {
        try {
          value = await capabilities.call('http@1', input);
        } catch (cause) {
          error = cause;
        }
        yield { type: 'output', output: null };
      },
    ],
  });
  const { runId } = await fixture.instance.start('public input');
  const events = await collect(fixture.instance.events(runId));
  await fixture.runtime.dispose();
  expect(fixture.scriptErrors).toEqual([]);
  return {
    value,
    error,
    publicFields: JSON.stringify([
      events,
      fixture.instance.getSnapshot(),
      error,
      fixture.diagnostics.map(({ error: _raw, ...generated }) => generated),
    ]),
  };
}
test('AE4 encodes path values and overwrites attribution headers after host credentials', async () => {
  let context: CapabilityContext | undefined;
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ ok: true }));
  const result = await call(
    httpCapability(
      options({
        fetch,
        headers: (ctx) => {
          context = ctx;
          return {
            'X-Galaxie-Agent': 'spoof',
            'x-galaxie-run': 'spoof',
            authorization: 'canary-credential-7f3a',
          };
        },
      }),
    ),
    inputSchema,
    { id: '../admin?x=1' },
  );
  expect(result.error).toBeUndefined();
  expect(result.value).toEqual({ ok: true });
  expect(fetch.mock.calls[0]?.[0]).toBe('https://api.example.test/lessons/..%2Fadmin%3Fx%3D1');
  const init = fetch.mock.calls[0]?.[1];
  expect(new Headers(init?.headers).get('x-galaxie-agent')).toBe('tests/agent@1.0.0');
  expect(new Headers(init?.headers).get('x-galaxie-run')).toBe(context?.runId);
  expect(new Headers(init?.headers).get('authorization')).toBe('canary-credential-7f3a');
  expect(init).toMatchObject({
    credentials: 'same-origin',
    redirect: 'error',
    signal: context?.signal,
  });
  expect(result.publicFields).not.toContain('canary-credential-7f3a');
});
test.each(['POST', 'PUT', 'PATCH', 'DELETE', 'GET'] as const)(
  '%s sends the write effect ID as Idempotency-Key after host headers',
  async (method) => {
    for (const hostKey of [undefined, 'host-key']) {
      let context: CapabilityContext | undefined;
      const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ ok: true }));
      const result = await call(
        httpCapability(
          options({
            kind: 'write',
            method,
            retry: 'idempotency-key',
            fetch,
            headers: async (ctx) => {
              context = ctx;
              return new Headers(hostKey === undefined ? [] : [['iDeMpOtEnCy-KeY', hostKey]]);
            },
          }),
        ),
        inputSchema,
        { id: 'a/b' },
      );
      expect(result.error).toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(context?.effectId).toMatch(/^[0-9a-f-]{36}$/);
      const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
      expect(headers.get('Idempotency-Key')).toBe(context?.effectId);
      expect(headers.get('x-galaxie-agent')).toBe('tests/agent@1.0.0');
      expect(headers.get('x-galaxie-run')).toBe(context?.runId);
    }
  },
);
test.each(['none', 'idempotent'] as const)(
  'retry %s leaves Idempotency-Key absent or exactly as the host supplied it',
  async (retry) => {
    for (const hostKey of [undefined, 'host-key']) {
      const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(null));
      const result = await call(
        httpCapability(
          options({
            kind: 'write',
            method: 'POST',
            retry,
            fetch,
            headers: () => new Headers(hostKey === undefined ? [] : [['Idempotency-Key', hostKey]]),
          }),
        ),
        inputSchema,
        { id: 'a/b' },
      );
      expect(result.error).toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('Idempotency-Key')).toBe(
        hostKey ?? null,
      );
    }
  },
);
test.each(values)('path injection value remains encoded or is denied: %j', async (id) => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(null));
  const result = await call(httpCapability(options({ fetch })), inputSchema, { id });
  if (['.', '..', '', '%2e', '%2E%2e'].includes(id)) {
    expect(result.error).toMatchObject({ code: 'denied' });
    expect(fetch).not.toHaveBeenCalled();
  } else {
    expect(result.error).toBeUndefined();
    expect(fetch.mock.calls[0]?.[0]).toBe(
      `https://api.example.test/lessons/${encodeURIComponent(id)}`,
    );
  }
});
test.each([
  'https://{id}.example.test/x',
  '{id}://api.example.test/x',
  'https://{id}@api.example.test/x',
  'https://api.example.test:{id}/x',
  'https://api.example.test/x#{id}',
  'https://api.example.test/x?{id}=v',
  'https://api.example.test/x/{missing}',
  'http://api.example.test/x/{id}',
  '/relative/{id}',
  'ftp://api.example.test/x/{id}',
])('rejects invalid templates before any request: %s', async (url) => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  await expect(async () => {
    const bound = httpCapability(options({ url, fetch }));
    await brokerFixture({
      requests: { 'http@1': { input: inputSchema, output: z.unknown(), kind: 'read' } },
      bindings: { 'http@1': bound },
    });
  }).rejects.toMatchObject({ code: 'invalid' });
  expect(fetch).not.toHaveBeenCalled();
});
test('rejects free-text paths, in-browser HTTP and remote user-device templates', async () => {
  for (const overrides of [
    {},
    { destination: 'in-browser' as const },
    { destination: 'user-device' as const },
  ]) {
    await expect(async () => {
      const bound = httpCapability(options(overrides));
      await brokerFixture({
        requests: {
          'http@1': { input: z.object({ id: z.string() }), output: z.unknown(), kind: 'read' },
        },
        bindings: { 'http@1': bound },
      });
    }).rejects.toMatchObject({ code: 'invalid' });
  }
});
test.each(['localhost', '127.0.0.1', '[::1]'])('permits loopback HTTP on %s', async (host) => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(null));
  expect(
    (
      await call(
        httpCapability(
          options({ url: `http://${host}/x/{id}`, destination: 'user-device', fetch }),
        ),
        inputSchema,
        { id: 'a/b' },
      )
    ).error,
  ).toBeUndefined();
});
test('GET query placeholders encode values, and POST sends only remaining input fields as JSON', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(null));
  const schema = z.object({ id: z.enum(['a/b']), query: z.string(), count: z.number() });
  await call(
    httpCapability(options({ url: 'https://api.example.test/search?q={query}', fetch })),
    schema,
    { id: 'a/b', query: '?x=1&#f', count: 2 },
  );
  expect(fetch.mock.calls[0]?.[0]).toBe('https://api.example.test/search?q=%3Fx%3D1%26%23f');
  await call(httpCapability(options({ method: 'POST', fetch })), schema, {
    id: 'a/b',
    query: 'body text',
    count: 2,
  });
  expect(fetch.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ query: 'body text', count: 2 }));
  expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get('content-type')).toBe(
    'application/json',
  );
});
test.each([204, 205])(
  'PUT with empty %i returns null and validates the output schema',
  async (status) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status }));
    expect(
      (await call(httpCapability(options({ method: 'PUT', fetch })), inputSchema, { id: 'a/b' }))
        .value,
    ).toBeNull();
    const fixture = await brokerFixture({
      requests: { 'http@1': { input: inputSchema, output: z.string(), kind: 'read' } },
      bindings: { 'http@1': httpCapability(options({ fetch })) },
      scripts: [
        async function* ({ capabilities }) {
          await expect(capabilities.call('http@1', { id: 'a/b' })).rejects.toMatchObject({
            code: 'invalid',
          });
          yield { type: 'output', output: null };
        },
      ],
    });
    const run = await fixture.instance.start('input');
    await collect(fixture.instance.events(run.runId));
    await fixture.runtime.dispose();
    expect(fixture.scriptErrors).toEqual([]);
  },
);
test.each([
  [401, 'denied'],
  [403, 'denied'],
  [400, 'invalid'],
  [404, 'invalid'],
  [500, 'unavailable'],
  [503, 'unavailable'],
  [302, 'unavailable'],
] as const)('maps HTTP %i to %s without response content', async (status, code) => {
  const result = await call(
    httpCapability(
      options({ fetch: async () => new Response('canary-response-body', { status }) }),
    ),
    inputSchema,
    { id: 'a/b' },
  );
  expect(result.error).toMatchObject({ code });
  expect(result.publicFields).not.toContain('canary-response-body');
});
test('network failures, blocked redirects, invalid JSON and other content types use fixed errors', async () => {
  for (const fetch of [
    async () => {
      throw new TypeError('canary-network-url');
    },
    async () => new Response('text', { headers: { 'content-type': 'text/plain' } }),
    async () =>
      new Response('canary-invalid-json', {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }),
  ]) {
    const result = await call(httpCapability(options({ fetch })), inputSchema, { id: 'a/b' });
    expect(result.error).toHaveProperty('code');
    expect(result.publicFields).not.toContain('canary');
  }
});
test('cancels an over-cap response stream and fails the run with payloadBytes', async () => {
  const cancel = vi.fn();
  const fetch: typeof globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(32));
        },
        cancel,
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  const result = await call(
    httpCapability(options({ url: 'https://api.example.test/fixed', fetch })),
    z.object({}),
    {},
    8,
  );
  expect(result.error).toMatchObject({ code: 'budget_exceeded' });
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(result.publicFields).toContain('budget_exceeded');
});
test('custom invoke bindings forward the same attribution headers', async () => {
  let headers: Readonly<Record<string, string>> | undefined;
  const bound = binding({
    invoke: async (_input, context) => {
      headers = attributionHeaders(context);
      return null;
    },
  });
  await call(bound, z.object({}), {});
  expect(headers?.['X-Galaxie-Agent']).toBe('tests/agent@1.0.0');
  expect(headers?.['X-Galaxie-Run']).toMatch(/^[0-9a-f-]{36}$/);
});
test('creating the helper, runtime and prepared instance never calls fetch', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const bound = httpCapability(options({ fetch }));
  const fixture = await brokerFixture({
    requests: { 'http@1': { input: inputSchema, output: z.unknown(), kind: 'read' } },
    bindings: { 'http@1': bound },
  });
  expect(fetch).not.toHaveBeenCalled();
  await fixture.runtime.dispose();
});
