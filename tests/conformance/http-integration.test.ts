// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { createLangGraphAdapter } from '@galaxie/adapter-langgraph';
import {
  type CapabilityBinding,
  createRuntime,
  type DiagnosticEvent,
  defineAgentDefinition,
  GalaxieError,
  type HttpCapabilityOptions,
  httpCapability,
} from '@galaxie/core';
import { MockChatModel } from '@galaxie/models/mock';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph/web';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import { afterAll, beforeAll, beforeEach, expect, inject, test } from 'vitest';
import { z } from 'zod';
import { binding, collect } from '../../packages/core/test/fake-executor.js';
import {
  HTTP_ERROR_BODY,
  HTTP_ORIGIN,
  type HttpAdminState,
  type HttpControl,
  type HttpFixture,
} from './support/http-context.js';
import { assistantRoles, assistantRouting } from './support/routing.js';

let fixture: HttpFixture;
let local: HttpControl | undefined;
beforeAll(async () => {
  if (typeof window === 'undefined') {
    const { createHttpFixture } = await import(/* @vite-ignore */ './support/http-fixture.node.js');
    local = await createHttpFixture();
    fixture = local.fixture;
  } else {
    fixture = inject('http');
    expect(location.origin).toBe(HTTP_ORIGIN);
    expect(new URL(fixture.corsUrl).origin).not.toBe(location.origin);
    expect(new URL(fixture.noCorsUrl).origin).not.toBe(new URL(fixture.corsUrl).origin);
  }
});
beforeEach(async () => {
  const response = await fetch(fixture.adminUrl, { method: 'POST' });
  expect(response.status).toBe(200);
});
afterAll(async () => {
  await local?.close();
});

async function recorded(): Promise<HttpAdminState> {
  const response = await fetch(fixture.adminUrl);
  expect(response.status).toBe(200);
  return (await response.json()) as HttpAdminState;
}

const requests = {
  'items.get@1': {
    kind: 'read' as const,
    input: z.object({ id: z.enum(['item-1', 'cors-item']) }),
    output: z.object({ id: z.string(), title: z.string() }),
  },
  'account.update@1': {
    kind: 'write' as const,
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
  },
  'auth.get@1': {
    kind: 'read' as const,
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
  },
};
const prompt = 'http-integration-prompt-canary';
const reply = 'http-integration-reply-canary';

function http(path: string, overrides: Partial<HttpCapabilityOptions> = {}): CapabilityBinding {
  return httpCapability({
    ...binding(),
    destination: 'host-server',
    url: `${fixture.corsUrl}${path}`,
    method: 'GET',
    ...overrides,
  });
}

async function run(name: keyof typeof requests, bound: CapabilityBinding, input: unknown) {
  let answer: unknown;
  let error: unknown;
  const diagnostics: DiagnosticEvent[] = [];
  const model = new MockChatModel({ [prompt]: { id: 'http-reply', text: reply } });
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  const runtime = createRuntime({
    appId: 'http-conformance',
    executors: [createLangGraphAdapter()],
    tracerProvider: provider,
    diagnostics: (event) => {
      diagnostics.push(event);
    },
  });
  const instance = await runtime.create(
    defineAgentDefinition({
      id: 'conformance/http',
      version: '1.0.0',
      executor: 'langgraph-js',
      input: z.object({}),
      models: assistantRoles,
      capabilities: { optional: requests },
    }),
    {
      principalScope: 'fixture',
      models: assistantRouting(),
      services: { chatModels: { assistant: model } },
      bindings: { [name]: bound },
      agent: (host) =>
        new StateGraph(Annotation.Root({ done: Annotation<boolean> }))
          .addNode('call', async (_state, config) => {
            // Native fixture streaming control; model text is neither state nor display data.
            await host.langchain.chatModel('assistant').invoke(prompt, {
              ...config,
              tags: ['nostream'],
            });
            try {
              answer = await host.capabilities.call(name, input, config);
            } catch (caught) {
              error = caught;
              throw caught;
            }
            return { done: true };
          })
          .addEdge(START, 'call')
          .addEdge('call', END)
          .compile(),
    },
  );
  try {
    await instance.prepare();
    const { runId } = await instance.start({});
    const events = await collect(instance.events(runId));
    await runtime.dispose();
    await provider.forceFlush();
    expect(model.calls).toBe(1);
    const spans = exporter.getFinishedSpans();
    expect(spans.filter((span) => span.name === `execute_tool ${name}`)).toHaveLength(1);
    const snapshot = instance.getSnapshot();
    const publicFields = JSON.stringify({
      events,
      snapshot,
      spans: spans.map((span) => ({
        name: span.name,
        attributes: span.attributes,
        events: span.events,
        status: span.status,
      })),
      diagnostics: diagnostics.map(({ error: _hostOnly, ...fields }) => fields),
      error: String(error),
    });
    for (const canary of [HTTP_ERROR_BODY, prompt, reply, 'fixture-token'])
      expect(publicFields).not.toContain(canary);
    // Host-only errors are inspected locally, never forwarded to public fields or exports.
    for (const diagnostic of diagnostics)
      expect(String(diagnostic.error)).not.toContain(HTTP_ERROR_BODY);
    return { runId, answer, error, events, snapshot, publicFields };
  } finally {
    await runtime.dispose();
    await provider.shutdown();
  }
}

function expectFailure(result: Awaited<ReturnType<typeof run>>, code: 'denied' | 'unavailable') {
  const message =
    code === 'denied' ? 'Policy denied the request.' : 'The requested service is unavailable.';
  expect(result.answer).toBeUndefined();
  expect(result.error).toBeInstanceOf(GalaxieError);
  expect(result.error).toMatchObject({ code, message });
  expect(result.error).not.toHaveProperty('cause');
  expect(result.snapshot.run).toMatchObject({ status: 'failed', error: { code, message } });
  expect(result.events.at(-1)).toMatchObject({ type: 'error', error: { code, message } });
  expect(result.events.some((event) => event.type === 'output')).toBe(false);
}

test('AT-24 a closed loopback user-device HTTP capability is unreachable', async () => {
  const url = `${fixture.closedUrl}/public/items/{id}`;
  const result = await run('items.get@1', http('', { url, destination: 'user-device' }), {
    id: 'item-1',
  });
  const message =
    'The endpoint did not answer. Local Network Access may be denied, CORS may not allow this app origin (for example OLLAMA_ORIGINS), or the server may be stopped.';
  expect(result.answer).toBeUndefined();
  expect(result.error).toBeInstanceOf(GalaxieError);
  expect(result.error).toMatchObject({ code: 'unreachable', message });
  expect(result.error).not.toHaveProperty('cause');
  expect(result.snapshot.run).toMatchObject({
    status: 'failed',
    error: { code: 'unreachable', message },
  });
  expect(result.events.at(-1)).toMatchObject({
    type: 'error',
    error: { code: 'unreachable', message },
  });
  for (const marker of [fixture.closedUrl, new URL(fixture.closedUrl).host, '127.0.0.1'])
    expect(result.publicFields).not.toContain(marker);
});

test('AT-24 a host fetch timeout stays unavailable while the broker signal is active', async () => {
  let brokerSignal: AbortSignal | undefined;
  const result = await run(
    'items.get@1',
    http('/hang', {
      destination: 'user-device',
      timeoutMs: 4000,
      fetch: (url, init) => {
        brokerSignal = init?.signal ?? undefined;
        return fetch(url, {
          ...init,
          signal: AbortSignal.any([
            brokerSignal ?? new AbortController().signal,
            AbortSignal.timeout(1000),
          ]),
        });
      },
    }),
    { id: 'item-1' },
  );
  expectFailure(result, 'unavailable');
  expect(brokerSignal?.aborted).toBe(false);
  expect((await recorded()).requests).toContainEqual(
    expect.objectContaining({
      server: 'cors',
      method: 'GET',
      path: '/hang',
      status: 0,
    }),
  );
});

test('AT-29 tags an HTTP read with the agent identity and run ID', async () => {
  const result = await run('items.get@1', http('/public/items/{id}'), { id: 'item-1' });
  expect(result.error).toBeUndefined();
  expect(result.answer).toEqual({ id: 'item-1', title: 'Fixture item' });
  expect(result.snapshot.run?.status).toBe('succeeded');
  const reads = (await recorded()).requests.filter((request) => request.method === 'GET');
  expect(reads).toEqual([
    expect.objectContaining({
      server: 'cors',
      path: '/public/items/item-1',
      agent: 'conformance/http@1.0.0',
      run: result.runId,
      status: 200,
    }),
  ]);
});

test.each(['override', 'remove'] as const)(
  'AT-29 a host headers callback cannot %s attribution on a sensitive write',
  async (attempt) => {
    const result = await run(
      'account.update@1',
      http('/sensitive/account', {
        kind: 'write',
        method: 'POST',
        headers: () => {
          const headers = new Headers({
            'x-galaxie-agent': 'spoofed-agent',
            'x-galaxie-run': 'spoofed-run',
          });
          if (attempt === 'remove') {
            headers.delete('x-galaxie-agent');
            headers.delete('x-galaxie-run');
          }
          return headers;
        },
      }),
      {},
    );
    expectFailure(result, 'denied');
    const writes = (await recorded()).requests.filter((request) => request.method === 'POST');
    expect(writes).toEqual([
      expect.objectContaining({
        server: 'cors',
        path: '/sensitive/account',
        agent: 'conformance/http@1.0.0',
        run: result.runId,
        status: 403,
        rejected: true,
      }),
    ]);
  },
);

test('AT-16 reports a real 401 and accepts a host-supplied bearer token', async () => {
  const denied = await run('auth.get@1', http('/auth/required'), {});
  expectFailure(denied, 'denied');
  const allowed = await run(
    'auth.get@1',
    http('/auth/required', { headers: () => ({ authorization: 'Bearer fixture-token' }) }),
    {},
  );
  expect(allowed.error).toBeUndefined();
  expect(allowed.answer).toEqual({ ok: true });
  expect(allowed.snapshot.run?.status).toBe('succeeded');
  const auth = (await recorded()).requests.filter((request) => request.method === 'GET');
  expect(auth.map((request) => request.status)).toEqual([401, 200]);
  expect(auth.map((request) => request.run)).toEqual([denied.runId, allowed.runId]);
  expect(auth.every((request) => request.agent === 'conformance/http@1.0.0')).toBe(true);
});

test.skipIf(typeof window === 'undefined')(
  'AT-16 allows a cross-origin HTTP binding after the custom-header preflight',
  async () => {
    // A distinct URL avoids the browser's preflight cache from earlier reads.
    const result = await run('items.get@1', http('/public/items/{id}'), { id: 'cors-item' });
    expect(result.error).toBeUndefined();
    expect(result.answer).toEqual({ id: 'cors-item', title: 'Fixture item' });
    const requests = (await recorded()).requests;
    expect(requests).toContainEqual(
      expect.objectContaining({
        server: 'cors',
        method: 'OPTIONS',
        path: '/public/items/cors-item',
        origin: HTTP_ORIGIN,
        requestedMethod: 'GET',
        status: 204,
      }),
    );
    const preflight = requests.find((request) => request.method === 'OPTIONS');
    expect(
      preflight?.requestedHeaders
        ?.split(',')
        .map((header) => header.trim())
        .sort(),
    ).toEqual(['x-galaxie-agent', 'x-galaxie-run']);
    expect(requests.filter((request) => request.method === 'GET')).toHaveLength(1);
  },
);

test.skipIf(typeof window === 'undefined')(
  'AT-16 reports a real CORS failure as unavailable without returning a result',
  async () => {
    const result = await run(
      'items.get@1',
      http('/public/items/{id}', {
        url: `${fixture.noCorsUrl}/public/items/{id}`,
        credentials: 'omit',
      }),
      { id: 'item-1' },
    );
    expectFailure(result, 'unavailable');
    expect((await recorded()).requests).toEqual([
      expect.objectContaining({
        server: 'no-cors',
        method: 'OPTIONS',
        path: '/public/items/item-1',
        origin: HTTP_ORIGIN,
        requestedMethod: 'GET',
        status: 204,
      }),
    ]);
  },
);
