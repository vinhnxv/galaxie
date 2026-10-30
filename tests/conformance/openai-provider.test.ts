// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { createLangGraphAdapter } from '@galaxie/adapter-langgraph';
import {
  createRuntime,
  type DestinationClass,
  type DiagnosticEvent,
  defineAgentDefinition,
} from '@galaxie/core';
import { MockChatModel } from '@galaxie/models/mock';
import { OpenAICompatibleChatModel, openAICompatible } from '@galaxie/models/openai';
import type { BaseMessage } from '@langchain/core/messages';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph/web';
import { afterAll, beforeAll, expect, inject, test, vi } from 'vitest';
import { z } from 'zod';
import { RunBudget } from '../../packages/core/src/budgets.js';
import { collect } from '../../packages/core/test/fake-executor.js';
import {
  assertSpanTree,
  createSpanRecorder,
  serializeSpans,
} from '../../packages/core/test/span-tree.js';
import {
  FakeOpenAIFetch,
  type FakeOpenAIOptions,
} from '../../packages/models/test/support/fake-openai-fetch.js';
import {
  HTTP_ORIGIN,
  type HttpAdminState,
  type HttpControl,
  type HttpFixture,
} from './support/http-context.js';

let httpFixture: HttpFixture;
let httpControl: HttpControl | undefined;
beforeAll(async () => {
  if (typeof window === 'undefined') {
    const { createHttpFixture } = await import(/* @vite-ignore */ './support/http-fixture.node.js');
    httpControl = await createHttpFixture();
    httpFixture = httpControl.fixture;
  } else httpFixture = inject('openaiHttp');
});
afterAll(async () => {
  await httpControl?.close();
});

// Exercise the provider contract in Chromium without collecting the Node suite twice.
if (typeof window !== 'undefined')
  await import('../../packages/models/test/openai-chat-model.test.js');

const state = Annotation.Root({ answer: Annotation<string> });
const definition = defineAgentDefinition({
  id: 'conformance/openai',
  version: '1.0.0',
  executor: 'langgraph-js',
  input: z.object({}),
  models: { assistant: { modality: 'text' } },
});
const schema = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
};

test.each(['invoke', 'stream'] as const)(
  'AT-24 a CORS-allowed loopback user-device model endpoint succeeds: %s',
  async (mode) => {
    const endpoint =
      typeof window === 'undefined'
        ? httpFixture.corsUrl
        : httpFixture.corsUrl.replace('127.0.0.1', 'localhost');
    const baseURL = `${endpoint}/v1`;
    const reset = await fetch(httpFixture.adminUrl, { method: 'POST' });
    expect(reset.status).toBe(200);
    const { exporter, provider } = createSpanRecorder();
    const diagnostics: DiagnosticEvent[] = [];
    let answer = '';
    let usage: unknown;
    const runtime = createRuntime({
      appId: 'loopback-success',
      dataPolicy: { app: { allow: ['user-device'] } },
      executors: [createLangGraphAdapter()],
      tracerProvider: provider,
      diagnostics: (event) => diagnostics.push(event),
    });
    try {
      const instance = await runtime.create(definition, {
        principalScope: 'test',
        services: { chatModels: { endpoint: openAICompatible({ baseURL, model: 'fake' }) } },
        models: {
          providers: {
            endpoint: {
              destination: 'user-device',
              modality: 'text',
              features: ['streaming'],
              pricing: { inputPerToken: 0, outputPerToken: 0 },
              credential: true,
            },
          },
          roles: { assistant: { providers: ['endpoint'], allow: ['user-device'], maxTokens: 100 } },
          consent: () => true,
          getCredential: () => 'loopback-credential-canary',
        },
        agent: (host) =>
          new StateGraph(state)
            .addNode('respond', async (_state, config) => {
              const model = host.langchain.chatModel('assistant');
              // Keep reply text out of graph state and native message events.
              const callConfig = { ...config, tags: ['nostream'] };
              if (mode === 'stream') {
                for await (const chunk of await model.stream(
                  'loopback-prompt-canary',
                  callConfig,
                )) {
                  answer += chunk.text;
                  usage = chunk.usage_metadata ?? usage;
                }
              } else {
                model.disableStreaming = true;
                const message = await model.invoke('loopback-prompt-canary', callConfig);
                answer = message.text;
                usage = message.usage_metadata;
              }
              return { answer: 'received' };
            })
            .addEdge(START, 'respond')
            .addEdge('respond', END)
            .compile(),
      });
      await instance.prepare();
      const { runId } = await instance.start({});
      const events = await collect(instance.events(runId));
      await runtime.dispose();
      await provider.forceFlush();
      expect(answer).toBe('loopback reply');
      expect(usage).toMatchObject({ input_tokens: 3, output_tokens: 2, total_tokens: 5 });
      expect(events.at(-1)).toMatchObject({ type: 'output', output: { answer: 'received' } });
      expect(events.filter((event) => event.type === 'error')).toEqual([]);
      expect(instance.getSnapshot().run).toMatchObject({ status: 'succeeded' });
      expect(instance.getSnapshot().routes?.['assistant']).toEqual({
        providerId: 'endpoint',
        destination: 'user-device',
      });
      const response = await fetch(httpFixture.adminUrl);
      expect(response.status).toBe(200);
      const recorded = (await response.json()) as HttpAdminState;
      expect(recorded.requests.filter((request) => request.method === 'POST')).toEqual([
        expect.objectContaining({ server: 'cors', path: '/v1/chat/completions', status: 200 }),
      ]);
      if (typeof window !== 'undefined') {
        expect(recorded.requests).toContainEqual(
          expect.objectContaining({
            method: 'OPTIONS',
            path: '/v1/chat/completions',
            origin: HTTP_ORIGIN,
            requestedMethod: 'POST',
            status: 204,
          }),
        );
        const headers = recorded.requests.find(
          (request) => request.method === 'OPTIONS',
        )?.requestedHeaders;
        expect(headers).toContain('authorization');
        expect(headers).toContain('content-type');
      }
      const spans = exporter.getFinishedSpans();
      assertSpanTree(spans);
      expect(
        spans.filter((span) => span.attributes['gen_ai.operation.name'] === 'chat'),
      ).toHaveLength(1);
      const exposed = JSON.stringify({
        events,
        snapshot: instance.getSnapshot(),
        diagnostics,
        spans: serializeSpans(spans),
      });
      for (const marker of [
        baseURL,
        new URL(baseURL).host,
        'localhost',
        '127.0.0.1',
        'loopback-prompt-canary',
        'loopback-credential-canary',
        'loopback reply',
      ])
        expect(exposed).not.toContain(marker);
    } finally {
      await runtime.dispose();
      await provider.shutdown();
    }
  },
);

test.each([
  ['user-device', 'invoke'],
  ['user-device', 'stream'],
  ['user-endpoint', 'invoke'],
  ['host-server', 'invoke'],
  ['third-party', 'invoke'],
  ['in-browser', 'invoke'],
] as const)('AT-24 closed loopback model endpoint: %s %s', async (destination, mode) => {
  await unreachableEndpoint(httpFixture.closedUrl, destination, mode);
});

test.skipIf(typeof window === 'undefined')(
  'AT-24 a no-CORS user-device model endpoint is unreachable without fallback',
  async () => {
    await unreachableEndpoint(httpFixture.noCorsUrl, 'user-device', 'invoke');
    const response = await fetch(httpFixture.adminUrl);
    expect(response.status).toBe(200);
    const recorded = (await response.json()) as HttpAdminState;
    expect(recorded.requests).toContainEqual(
      expect.objectContaining({
        server: 'no-cors',
        method: 'OPTIONS',
        path: '/chat/completions',
        origin: HTTP_ORIGIN,
        requestedMethod: 'POST',
        status: 204,
      }),
    );
    expect(
      recorded.requests.filter(
        (request) => request.server === 'no-cors' && request.method === 'POST',
      ),
    ).toHaveLength(0);
  },
);

test.each([
  ['user-device', 'invoke'],
  ['user-device', 'stream'],
  ['user-endpoint', 'invoke'],
  ['user-endpoint', 'stream'],
  ['host-server', 'invoke'],
  ['host-server', 'stream'],
  ['third-party', 'invoke'],
  ['third-party', 'stream'],
  ['in-browser', 'invoke'],
  ['in-browser', 'stream'],
] as const)('AT-24 preconstructed loopback model endpoint: %s %s', async (destination, mode) => {
  const baseURL = httpFixture.closedUrl.replace('127.0.0.1', 'localhost');
  const model = new OpenAICompatibleChatModel(
    { baseURL, model: 'fake' },
    'endpoint-credential-canary',
  );
  await unreachableEndpoint(baseURL, destination, mode, model);
});

test.each(['invoke', 'stream'] as const)(
  'AT-24 concurrent roles share a preconstructed model: %s',
  async (mode) => {
    const baseURL = httpFixture.closedUrl.replace('127.0.0.1', 'localhost');
    const model = new OpenAICompatibleChatModel(
      { baseURL, model: 'fake' },
      'endpoint-credential-canary',
    );
    await Promise.all([
      unreachableEndpoint(baseURL, 'user-device', mode, model),
      unreachableEndpoint(baseURL, 'host-server', mode, model),
    ]);
  },
);

async function unreachableEndpoint(
  baseURL: string,
  destination: DestinationClass,
  mode: 'invoke' | 'stream',
  preconstructed?: OpenAICompatibleChatModel,
): Promise<void> {
  // Distinguish the endpoint host from Vitest's source URLs in browser error stacks.
  baseURL = baseURL.replace('127.0.0.1', 'localhost');
  const fallback = new MockChatModel({
    'endpoint-prompt-canary': { id: 'unused', text: 'unused' },
  });
  const spy = vi.spyOn(fallback, '_generate');
  const { exporter, provider } = createSpanRecorder();
  const diagnostics: DiagnosticEvent[] = [];
  let caught: unknown;
  const runtime = createRuntime({
    appId: 'endpoint-conformance',
    dataPolicy: { app: { allow: [destination, 'in-browser'] } },
    executors: [createLangGraphAdapter()],
    tracerProvider: provider,
    diagnostics: (event) => diagnostics.push(event),
  });
  try {
    const instance = await runtime.create(definition, {
      principalScope: 'test',
      services: {
        chatModels: {
          endpoint: preconstructed ?? openAICompatible({ baseURL, model: 'fake' }),
          fallback,
        },
      },
      models: {
        providers: {
          endpoint: {
            destination,
            modality: 'text',
            features: ['streaming'],
            pricing: { inputPerToken: 0, outputPerToken: 0 },
            credential: preconstructed === undefined,
          },
          fallback: {
            destination: 'in-browser',
            modality: 'text',
            features: ['streaming'],
            pricing: { inputPerToken: 0, outputPerToken: 0 },
          },
        },
        roles: {
          assistant: {
            providers: ['endpoint', 'fallback'],
            allow: [destination, 'in-browser'],
            maxTokens: 100,
          },
        },
        consent: () => true,
        getCredential: () => 'endpoint-credential-canary',
      },
      agent: (host) =>
        new StateGraph(state)
          .addNode('respond', async (_state, config) => {
            const model = host.langchain.chatModel('assistant');
            try {
              if (mode === 'stream') {
                for await (const _chunk of await model.stream('endpoint-prompt-canary', config)) {
                  /* drain */
                }
              } else {
                model.disableStreaming = true;
                await model.invoke('endpoint-prompt-canary', config);
              }
            } catch (error) {
              caught = error;
              throw error;
            }
            return { answer: 'unexpected-success' };
          })
          .addEdge(START, 'respond')
          .addEdge('respond', END)
          .compile(),
    });
    await instance.prepare();
    const { runId } = await instance.start({});
    const events = await collect(instance.events(runId));
    await runtime.dispose();
    await provider.forceFlush();
    const code = ['user-device', 'user-endpoint'].includes(destination)
      ? 'unreachable'
      : 'unavailable';
    const message =
      code === 'unreachable'
        ? 'The endpoint did not answer. Local Network Access may be denied, CORS may not allow this app origin (for example OLLAMA_ORIGINS), or the server may be stopped.'
        : 'The requested service is unavailable.';
    expect(caught).toMatchObject({ code });
    expect(caught).not.toHaveProperty('cause');
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { code, message } });
    expect(instance.getSnapshot().run).toMatchObject({
      status: 'failed',
      error: { code, message },
    });
    expect(spy).not.toHaveBeenCalled();
    expect(fallback.calls).toBe(0);
    const spans = exporter.getFinishedSpans();
    assertSpanTree(spans);
    expect(
      spans.filter((span) => span.attributes['gen_ai.operation.name'] === 'chat'),
    ).toHaveLength(1);
    const fields = JSON.stringify({
      events,
      snapshot: instance.getSnapshot(),
      spans: serializeSpans(spans),
      diagnostics,
      error:
        caught instanceof Error
          ? { ...caught, message: caught.message, stack: caught.stack }
          : caught,
    });
    for (const marker of [
      baseURL,
      new URL(baseURL).host,
      'localhost',
      'endpoint-prompt-canary',
      'endpoint-credential-canary',
    ])
      expect(fields).not.toContain(marker);
  } finally {
    spy.mockRestore();
    await runtime.dispose();
    await provider.shutdown();
  }
}

test.each([
  'invoke',
  'stream',
  'structured',
  'no-usage',
  'zero-input',
  'zero-output',
  'zero-usage',
  'truncated',
  'read-error',
  'cancel',
  'consent-denied',
  'no-consent',
  '401',
  '429',
  '500',
  'network',
  'malformed',
  'non-json',
  'schema-invalid',
] as const)('OpenAI-compatible routed provider: %s', async (mode) => {
  const entered = Promise.withResolvers<void>();
  const blocked = Promise.withResolvers<void>();
  const structured = ['structured', 'non-json', 'schema-invalid'].includes(mode);
  const fakeOptions: FakeOpenAIOptions = {
    ...(mode === '401' || mode === '429' || mode === '500' ? { status: Number(mode) } : {}),
    ...(mode === 'network' ? { failure: true } : {}),
    ...(mode === 'malformed' ? { malformed: true } : {}),
    ...(mode === 'no-usage' ? { usage: false } : {}),
    ...(mode === 'zero-input'
      ? { usage: { prompt_tokens: 0, completion_tokens: 2, total_tokens: 2 } }
      : {}),
    ...(mode === 'zero-output'
      ? { usage: { prompt_tokens: 3, completion_tokens: 0, total_tokens: 3 } }
      : {}),
    ...(mode === 'zero-usage'
      ? { usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }
      : {}),
    ...(mode === 'truncated' || mode === 'read-error'
      ? { truncate: true, streamFailure: mode === 'read-error' }
      : {}),
    ...(structured
      ? {
          text:
            mode === 'structured'
              ? '{"answer":"yes"}'
              : mode === 'non-json'
                ? 'endpoint-body-marker'
                : '{"answer":1}',
        }
      : {}),
    beforeChunk: async (index) => {
      if (mode === 'cancel' && index === 1) {
        entered.resolve();
        await blocked.promise;
      }
    },
  };
  const fake = new FakeOpenAIFetch(fakeOptions);
  const credentials = ['first-credential-canary', 'second-credential-canary'];
  const getCredential = vi.fn(({ providerId }: { providerId: string }) => {
    expect(providerId).toBe('proxy');
    return credentials[getCredential.mock.calls.length - 1] ?? '';
  });
  const consent = vi.fn(() => mode !== 'consent-denied');
  const charges: { tokens: number; cost: number }[] = [];
  const originalReserve = RunBudget.prototype.reserveModel;
  const reserve = vi.spyOn(RunBudget.prototype, 'reserveModel').mockImplementation(function (
    this: RunBudget,
    tokens,
    cost,
  ) {
    const reservation = originalReserve.call(this, tokens, cost);
    const index = charges.push({ tokens, cost }) - 1;
    const settle = reservation.settle;
    reservation.settle = (chargedTokens, chargedCost): void => {
      charges[index] = { tokens: chargedTokens, cost: chargedCost };
      settle(chargedTokens, chargedCost);
    };
    return reservation;
  });
  const { exporter, provider } = createSpanRecorder();
  const diagnostics: DiagnosticEvent[] = [];
  const runtime = createRuntime({
    appId: 'openai-conformance',
    executors: [createLangGraphAdapter()],
    tracerProvider: provider,
    diagnostics: (event) => diagnostics.push(event),
    budgets: { tokens: 1000, cost: 1000 },
  });
  const callCount = mode === 'invoke' ? 2 : 1;
  try {
    const instance = await runtime.create(definition, {
      principalScope: 'test',
      services: {
        chatModels: {
          proxy: openAICompatible({
            baseURL: 'https://proxy.example/v1',
            model: 'fake',
            fetch: fake.fetch,
            maxTokens: 12,
          }),
        },
      },
      models: {
        providers: {
          proxy: {
            destination: 'host-server',
            modality: 'text',
            features: ['streaming', 'cancellation', 'structured-output'],
            pricing: { inputPerToken: 1, outputPerToken: 2 },
            credential: true,
          },
        },
        roles: { assistant: { providers: ['proxy'], allow: ['host-server'], maxTokens: 100 } },
        getCredential,
        ...(mode === 'no-consent' ? {} : { consent }),
      },
      agent: (host) =>
        new StateGraph(state)
          .addNode('respond', async (_state, config) => {
            const model = host.langchain.chatModel('assistant');
            let answer = '';
            if (
              mode === 'stream' ||
              mode === 'cancel' ||
              mode === 'truncated' ||
              mode === 'read-error'
            ) {
              for await (const chunk of await model.stream('prompt-canary', config))
                answer += chunk.text;
            } else {
              // Ensure structured failures exercise the SDK's non-streaming parse path.
              model.disableStreaming = true;
              for (let call = 0; call < callCount; call++) {
                if (structured)
                  answer += JSON.stringify(
                    await model.withStructuredOutput(schema).invoke('prompt-canary', config),
                  );
                else answer += (await model.invoke('prompt-canary', config)).text;
              }
            }
            return { answer };
          })
          .addEdge(START, 'respond')
          .addEdge('respond', END)
          .compile(),
    });
    await instance.prepare();
    const { runId } = await instance.start({});
    if (mode === 'cancel') {
      await entered.promise;
      await instance.cancel(runId);
      blocked.resolve();
    }
    const events = await collect(instance.events(runId));
    await runtime.dispose();
    await provider.forceFlush();
    const succeeded = [
      'invoke',
      'stream',
      'structured',
      'no-usage',
      'zero-input',
      'zero-output',
      'zero-usage',
    ].includes(mode);
    const denied = mode === 'consent-denied' || mode === 'no-consent';
    expect(getCredential).toHaveBeenCalledTimes(denied ? 0 : callCount);
    expect(fake.requests).toHaveLength(denied ? 0 : callCount);
    expect(consent).toHaveBeenCalledTimes(mode === 'no-consent' ? 0 : 1);
    for (const [index, request] of fake.requests.entries()) {
      expect(request.url).toBe('https://proxy.example/v1/chat/completions');
      expect(request.headers.get('authorization')).toBe(`Bearer ${credentials[index]}`);
      expect(request.body['max_tokens']).toBe(12);
      expect(JSON.stringify(request.body)).not.toContain('credential-canary');
      if (index === 1)
        expect(JSON.stringify({ body: request.body, headers: [...request.headers] })).not.toContain(
          credentials[0],
        );
    }
    if (succeeded) {
      expect(events.at(-1)).toMatchObject({
        type: 'output',
        output: {
          answer: mode === 'structured' ? '{"answer":"yes"}' : 'hello world'.repeat(callCount),
        },
      });
      const expectedCharges: Record<string, { tokens: number; cost: number }> = {
        'no-usage': { tokens: 100, cost: 200 },
        'zero-input': { tokens: 2, cost: 4 },
        'zero-output': { tokens: 3, cost: 3 },
        'zero-usage': { tokens: 0, cost: 0 },
      };
      expect(charges).toEqual(
        Array.from({ length: callCount }, () => expectedCharges[mode] ?? { tokens: 5, cost: 7 }),
      );
      expect(instance.getSnapshot().routes?.['assistant']).toEqual({
        providerId: 'proxy',
        destination: 'host-server',
      });
    } else if (mode === 'cancel') {
      expect(events.at(-1)?.type).toBe('cancelled');
      expect(instance.getSnapshot().run?.status).toBe('cancelled');
      expect(fake.requests[0]?.signal.aborted).toBe(true);
    } else {
      const code = denied
        ? 'denied'
        : mode === 'schema-invalid'
          ? 'invalid'
          : ['malformed', 'non-json', 'truncated', 'read-error'].includes(mode)
            ? 'executor_error'
            : 'unavailable';
      expect(events.at(-1)).toMatchObject({ type: 'error', error: { code } });
      if (mode === 'truncated' || mode === 'read-error')
        expect(charges).toEqual([{ tokens: 100, cost: 200 }]);
    }
    if (structured)
      expect(fake.requests[0]?.body['response_format']).toEqual({
        type: 'json_schema',
        json_schema: { name: 'output', strict: true, schema },
      });
    if (mode === 'stream') {
      const text = events
        .filter((event) => event.type === 'stream' && event.mode === 'messages')
        .map(
          (event) =>
            ((event as Extract<typeof event, { type: 'stream' }>).data as [BaseMessage, unknown])[0]
              .content,
        )
        .join('');
      expect(text).toBe('hello world');
    }
    const spans = exporter.getFinishedSpans();
    assertSpanTree(spans);
    const modelSpans = spans.filter((span) => span.attributes['gen_ai.operation.name'] === 'chat');
    expect(modelSpans).toHaveLength(denied ? 0 : callCount);
    const telemetry = JSON.stringify({
      diagnostics: diagnostics.map(({ error, ...event }) => ({
        ...event,
        ...(error instanceof Error
          ? { error: { ...error, message: error.message, stack: error.stack } }
          : { error }),
      })),
      spans: serializeSpans(spans),
      snapshot: instance.getSnapshot(),
      errors: events.filter((event) => event.type === 'error'),
    });
    for (const marker of [
      ...credentials,
      'prompt-canary',
      'endpoint-body-marker',
      'hello world',
      '{"answer":"yes"}',
    ])
      expect(telemetry).not.toContain(marker);
  } finally {
    blocked.resolve();
    await runtime.dispose();
    await provider.shutdown();
    reserve.mockRestore();
  }
});
