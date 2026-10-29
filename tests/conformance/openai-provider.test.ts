// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { createLangGraphAdapter } from '@galaxie/adapter-langgraph';
import { createRuntime, type DiagnosticEvent, defineAgentDefinition } from '@galaxie/core';
import { openAICompatible } from '@galaxie/models/openai';
import type { BaseMessage } from '@langchain/core/messages';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph/web';
import { expect, test, vi } from 'vitest';
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

test.each([
  'invoke',
  'stream',
  'structured',
  'no-usage',
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
            if (mode === 'stream' || mode === 'cancel') {
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
    const succeeded = ['invoke', 'stream', 'structured', 'no-usage'].includes(mode);
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
      expect(charges).toEqual(
        Array.from({ length: callCount }, () =>
          mode === 'no-usage' ? { tokens: 100, cost: 200 } : { tokens: 5, cost: 7 },
        ),
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
          : ['malformed', 'non-json'].includes(mode)
            ? 'executor_error'
            : 'unavailable';
      expect(events.at(-1)).toMatchObject({ type: 'error', error: { code } });
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
