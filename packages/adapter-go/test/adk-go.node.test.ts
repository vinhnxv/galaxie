// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createRuntime, defineAgentDefinition, type RunEvent } from '@galaxie-ai/core';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import { createMockLatch, MockChatModel } from '../../models/src/mock.js';
import { createGoAdapter, type GoAgent } from '../src/index.js';
import { MAX_DELTA_LENGTH } from '../src/stream.js';
import { collect, FakeGoWorker, failResult, okResult, type Program } from './support-go.js';

const agent: GoAgent = {
  wasm: { url: 'http://127.0.0.1/go/agent.wasm', sha256: 'a'.repeat(64), bytes: 1024 },
  entry: 'reference',
};
const definition = defineAgentDefinition({
  id: 'conformance/adk-go',
  version: '1.0.0',
  executor: 'adk-go',
  input: z.object({ prompt: z.string() }),
  capabilities: {
    required: {
      'docs.search@1': {
        kind: 'read',
        input: z.object({ query: z.string() }),
        output: z.object({ hits: z.number() }),
      },
    },
  },
  models: { answer: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' } },
});
const provider = {
  destination: 'in-browser' as const,
  modality: 'text' as const,
  features: ['tool-calling' as const],
  languages: ['en'],
  pricing: { inputPerToken: 0, outputPerToken: 0 },
};
const userMessage = (content: string): unknown => [{ role: 'user', content }];
const modelPayload = (content: string, options: object = {}): unknown => ({
  role: 'answer',
  messages: userMessage(content),
  options,
});

async function harness(
  program: Program,
  script: ConstructorParameters<typeof MockChatModel>[0],
  workerOptions: ConstructorParameters<typeof FakeGoWorker>[1] = {},
  capability = vi.fn(async () => ({ hits: 2 })),
  adjust: (model: MockChatModel) => void = () => undefined,
  streaming: {
    readonly stream?: boolean;
    /** Pause after each event the adapter yields, as a slow consumer of its generator would. */
    readonly pauseMs?: number;
    readonly safety?: NonNullable<Parameters<typeof createRuntime>[0]['outputSafety']>;
  } = {},
) {
  const worker = new FakeGoWorker(program, workerOptions);
  const model = new MockChatModel(script);
  adjust(model);
  const adapter = createGoAdapter({ createWorker: () => worker });
  const pauseMs = streaming.pauseMs;
  const executor =
    pauseMs === undefined
      ? adapter
      : {
          ...adapter,
          prepare: async (...args: Parameters<typeof adapter.prepare>) => {
            const prepared = await adapter.prepare(...args);
            return {
              ...prepared,
              run: (request: Parameters<typeof prepared.run>[0]) =>
                (async function* () {
                  for await (const event of prepared.run(request)) {
                    yield event;
                    await new Promise<void>((resolve) => setTimeout(resolve, pauseMs));
                  }
                })(),
            };
          },
        };
  const runtime = createRuntime({
    appId: 'adk-go-test',
    executors: [executor],
    outputSafety: streaming.safety ?? (() => 'allow'),
  });
  const instance = await runtime.create(definition, {
    principalScope: 'fixture',
    agent: streaming.stream ? { ...agent, stream: true } : agent,
    services: { chatModels: { mock: model } },
    models: {
      providers: { mock: provider },
      roles: { answer: { providers: ['mock'], allow: ['in-browser'], maxTokens: 100 } },
    },
    bindings: {
      'docs.search@1': {
        kind: 'read',
        destination: 'in-browser',
        timeoutMs: 5000,
        concurrency: 1,
        grantScope: 'instance',
        approval: 'none',
        retry: 'none',
        invoke: capability,
      },
    },
  });
  await instance.prepare();
  return { worker, runtime, instance, capability };
}
const last = (events: RunEvent[]): RunEvent | undefined => events.at(-1);

test('a run serves a model request through the router and returns the final text', async () => {
  const { instance, runtime, worker } = await harness(
    async (api) => {
      const reply = JSON.parse(await api.call('model', modelPayload('hello'))) as {
        content: string;
      };
      return okResult(`${api.request.prompt}:${reply.content}`);
    },
    {
      hello: {
        id: 'a',
        text: 'hi there',
        usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      },
    },
  );
  const { runId } = await instance.start({ prompt: 'hello' });
  expect(last(await collect(instance.events(runId)))).toMatchObject({
    type: 'output',
    output: 'hello:hi there',
  });
  expect(worker.received.map((message) => message.kind)).toEqual(['run', 'reply']);
  await runtime.dispose();
  expect(worker.terminated).toBe(true);
});

test('model tool calls and capability calls round-trip with an effect scope', async () => {
  const seen: unknown[] = [];
  const { instance, runtime, capability } = await harness(
    async (api) => {
      const tools = [
        {
          type: 'function',
          function: { name: 'search', parameters: { type: 'object', properties: {} } },
        },
      ];
      const first = JSON.parse(await api.call('model', modelPayload('hello', { tools }))) as {
        toolCalls: Array<{ id: string; function: { name: string; arguments: string } }>;
      };
      seen.push(first.toolCalls);
      const found = await api.call('capability', {
        name: 'docs.search@1',
        input: { query: 'paris' },
        effectScope: 'adk-go/g1/root/1/0',
      });
      seen.push(JSON.parse(found));
      return okResult('done');
    },
    {
      hello: {
        id: 'a',
        text: '',
        toolCalls: [{ id: 'call-1', name: 'search', args: { query: 'paris' } }],
      },
    },
  );
  const { runId } = await instance.start({ prompt: 'hello' });
  expect(last(await collect(instance.events(runId)))).toMatchObject({ output: 'done' });
  expect(seen).toEqual([
    [
      {
        id: 'call-1',
        type: 'function',
        function: { name: 'search', arguments: '{"query":"paris"}' },
      },
    ],
    { hits: 2 },
  ]);
  expect(capability).toHaveBeenCalledTimes(1);
  await runtime.dispose();
});

test('a denied or unavailable bridge reply reaches the program as a code', async () => {
  const codes: string[] = [];
  const { instance, runtime } = await harness(async (api) => {
    for (const payload of [
      { role: 'nobody', messages: userMessage('x'), options: {} },
      'not json',
      { role: 'answer', messages: [], options: {} },
    ])
      await api.call('model', payload).catch((error: Error) => codes.push(error.message));
    await api
      .call('capability', { name: 'missing@1', input: {} })
      .catch((error: Error) => codes.push(error.message));
    return failResult(codes[0] ?? 'none');
  }, {});
  const { runId } = await instance.start({ prompt: 'x' });
  const events = await collect(instance.events(runId));
  expect(codes).toHaveLength(4);
  expect(codes.slice(1, 3)).toEqual(['invalid', 'invalid']);
  expect(last(events)).toMatchObject({ type: 'error' });
  await runtime.dispose();
});

const streamed = (events: readonly RunEvent[], mode: string): Record<string, unknown>[] =>
  events.flatMap((event) =>
    event.type === 'stream' && event.mode === mode ? [event.data as Record<string, unknown>] : [],
  );
const streamRequest = (content: string, options: object = {}): unknown => ({
  role: 'answer',
  author: 'writer',
  messages: userMessage(content),
  options: { stream: true, ...options },
});

test('a streaming run emits checked text deltas in order and the program gets one final reply', async () => {
  const replies: string[] = [];
  const { instance, runtime } = await harness(
    async (api) => {
      const reply = JSON.parse(await api.call('model', streamRequest('hello'))) as {
        content: string;
      };
      replies.push(reply.content);
      return okResult(reply.content);
    },
    { hello: { id: 'a', text: 'alpha beta gamma' } },
    {},
    undefined,
    undefined,
    { stream: true },
  );
  const { runId } = await instance.start({ prompt: 'hello' });
  const events = await collect(instance.events(runId));
  expect(streamed(events, 'messages')).toEqual([
    { author: 'writer', text: 'alpha ' },
    { author: 'writer', text: 'beta ' },
    { author: 'writer', text: 'gamma' },
  ]);
  expect(replies).toEqual(['alpha beta gamma']);
  expect(last(events)).toMatchObject({ type: 'output', output: 'alpha beta gamma' });
  expect(
    events.every(
      (event) =>
        event.type !== 'stream' || (event.executor === 'adk-go' && event.path.length === 0),
    ),
  ).toBe(true);
  await runtime.dispose();
});

test('events queued while the adapter generator is suspended still precede the output', async () => {
  const { instance, runtime } = await harness(
    async (api) => {
      await api.call('model', streamRequest('hello'));
      // Later events are queued while the consumer is still suspended on an earlier one.
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      const reply = JSON.parse(await api.call('model', streamRequest('again'))) as {
        content: string;
      };
      return okResult(reply.content);
    },
    { hello: { id: 'a', text: 'alpha beta' }, again: { id: 'b', text: 'delta epsilon' } },
    {},
    undefined,
    undefined,
    { stream: true, pauseMs: 40 },
  );
  const { runId } = await instance.start({ prompt: 'hello' });
  const events = await collect(instance.events(runId));
  expect(streamed(events, 'messages').map((item) => item['text'])).toEqual([
    'alpha ',
    'beta',
    'delta ',
    'epsilon',
  ]);
  expect(last(events)).toMatchObject({ type: 'output', output: 'delta epsilon' });
  await runtime.dispose();
});

test('a run that did not ask for a stream refuses a streaming request with a fixed code', async () => {
  let code = '';
  const { instance, runtime } = await harness(
    async (api) => {
      await api.call('model', streamRequest('hello')).catch((error: Error) => {
        code = error.message;
      });
      return okResult('after');
    },
    { hello: { id: 'a', text: 'x' } },
  );
  const { runId } = await instance.start({ prompt: 'hello' });
  const events = await collect(instance.events(runId));
  expect(code).toBe('invalid');
  expect(streamed(events, 'messages')).toEqual([]);
  await runtime.dispose();
});

test('a tool turn emits content-free markers and never a call ID, argument or result', async () => {
  const { instance, runtime } = await harness(
    async (api) => {
      const tools = [
        {
          type: 'function',
          function: { name: 'search', parameters: { type: 'object', properties: {} } },
        },
      ];
      const reply = JSON.parse(await api.call('model', streamRequest('hello', { tools }))) as {
        toolCalls: { function: { arguments: string } }[];
      };
      expect(reply.toolCalls).toHaveLength(1);
      await api.call('capability', { name: 'docs.search@1', input: { query: 'secret-arg' } });
      return okResult('done');
    },
    {
      hello: {
        id: 'a',
        text: 'looking',
        toolCalls: [{ id: 'canary-call-id', name: 'search', args: { query: 'secret-arg' } }],
      },
    },
    {},
    vi.fn(async () => ({ hits: 7 })),
    undefined,
    { stream: true },
  );
  const { runId } = await instance.start({ prompt: 'hello' });
  const events = await collect(instance.events(runId));
  expect(streamed(events, 'updates')).toEqual([
    { step: 'tool_call', tool: 'search', index: 0 },
    { step: 'tool_result', tool: 'docs.search@1', index: 1 },
  ]);
  const wire = JSON.stringify(events.filter((event) => event.type === 'stream'));
  for (const canary of ['canary-call-id', 'secret-arg', '"hits"'])
    expect(wire).not.toContain(canary);
  await runtime.dispose();
});

test('a mid-stream block fails the call denied and the blocked delta never reaches the host', async () => {
  let code = '';
  const { instance, runtime } = await harness(
    async (api) => {
      await api.call('model', streamRequest('hello')).catch((error: Error) => {
        code = error.message;
      });
      return failResult(code);
    },
    { hello: { id: 'a', text: 'safe BLOCKED_TEXT after' } },
    {},
    undefined,
    undefined,
    { stream: true, safety: ({ text }) => (text.includes('BLOCKED_TEXT') ? 'block' : 'allow') },
  );
  const { runId } = await instance.start({ prompt: 'hello' });
  const events = await collect(instance.events(runId));
  expect(code).toBe('denied');
  expect(last(events)).toMatchObject({ type: 'error', error: { code: 'denied' } });
  expect(streamed(events, 'messages')).toEqual([{ author: 'writer', text: 'safe ' }]);
  expect(JSON.stringify(events)).not.toContain('BLOCKED_TEXT');
  await runtime.dispose();
});

test('a long delta is split at the bound and never inside a surrogate pair', async () => {
  const long = `${'a'.repeat(MAX_DELTA_LENGTH - 1)}\u{1F600}${'b'.repeat(5)}`;
  const { instance, runtime } = await harness(
    async (api) => {
      await api.call('model', streamRequest('hello'));
      return okResult('done');
    },
    { hello: { id: 'a', text: long } },
    {},
    undefined,
    undefined,
    { stream: true },
  );
  const { runId } = await instance.start({ prompt: 'hello' });
  const texts = streamed(await collect(instance.events(runId)), 'messages').map((data) =>
    String(data['text']),
  );
  expect(texts.join('')).toBe(long);
  expect(texts.every((text) => text.length <= MAX_DELTA_LENGTH)).toBe(true);
  for (const text of texts) expect(text).toBe(text.toWellFormed());
  await runtime.dispose();
});

test('an abort mid-stream stops further deltas and settles the run cancelled', async () => {
  const gate = Promise.withResolvers<void>();
  let checks = 0;
  const { instance, runtime } = await harness(
    async (api) => {
      await api.call('model', streamRequest('hello')).catch(() => undefined);
      await api.cancelled;
      return failResult('cancelled');
    },
    { hello: { id: 'a', text: 'alpha beta gamma' } },
    {},
    undefined,
    undefined,
    {
      stream: true,
      safety: async (): Promise<'allow'> => {
        checks += 1;
        if (checks === 2) await gate.promise;
        return 'allow';
      },
    },
  );
  const { runId } = await instance.start({ prompt: 'hello' });
  const events: RunEvent[] = [];
  let cancelling: ReturnType<typeof instance.cancel> | undefined;
  for await (const event of instance.events(runId)) {
    events.push(event);
    if (event.type === 'stream' && cancelling === undefined) {
      cancelling = instance.cancel(runId);
      gate.resolve();
    }
  }
  await cancelling;
  expect(last(events)?.type).toBe('cancelled');
  expect(streamed(events, 'messages')).toEqual([{ author: 'writer', text: 'alpha ' }]);
  await runtime.dispose();
});

test('a program failure code becomes the run error', async () => {
  const { instance, runtime } = await harness(async () => failResult('budget_exceeded'), {});
  const { runId } = await instance.start({ prompt: 'x' });
  expect(last(await collect(instance.events(runId)))).toMatchObject({
    type: 'error',
    error: { code: 'budget_exceeded' },
  });
  await runtime.dispose();
});

test('an unknown program failure code maps to executor_error', async () => {
  const { instance, runtime } = await harness(async () => failResult('panic: boom'), {});
  const { runId } = await instance.start({ prompt: 'x' });
  expect(last(await collect(instance.events(runId)))).toMatchObject({
    error: { code: 'executor_error' },
  });
  await runtime.dispose();
});

test('cancelling a run asks the program to stop and waits for it', async () => {
  const latch = createMockLatch();
  const { instance, runtime, worker } = await harness(
    async (api) => {
      const pending = api.call('model', modelPayload('slow')).catch(() => '');
      await api.cancelled;
      await pending;
      return failResult('cancelled');
    },
    { slow: { id: 'a', text: 'late', wait: latch } },
  );
  const { runId } = await instance.start({ prompt: 'slow' });
  await vi.waitFor(() =>
    expect(worker.received.some((message) => message.kind === 'run')).toBe(true),
  );
  await latch.entered;
  await instance.cancel(runId);
  const events = await collect(instance.events(runId));
  expect(last(events)).toMatchObject({ type: 'cancelled' });
  expect(worker.received.map((message) => message.kind)).toContain('cancel');
  expect(worker.terminated).toBe(false);
  await runtime.dispose();
});

test('a program that ignores cancellation is terminated and the next run fails unavailable', async () => {
  const latch = createMockLatch();
  const { instance, runtime, worker } = await harness(
    async (api) => {
      await api.call('model', modelPayload('slow')).catch(() => '');
      await new Promise<void>(() => {});
      return okResult('never');
    },
    { slow: { id: 'a', text: 'late', wait: latch } },
    { silentOnCancel: true },
  );
  const { runId } = await instance.start({ prompt: 'slow' });
  await latch.entered;
  await instance.cancel(runId);
  await collect(instance.events(runId));
  await vi.waitFor(() => expect(worker.terminated).toBe(true), { timeout: 3000 });
  const next = await instance.start({ prompt: 'again' });
  expect(last(await collect(instance.events(next.runId)))).toMatchObject({
    type: 'error',
    error: { code: expect.stringMatching(/^(unavailable|unrecoverable)$/) },
  });
  await runtime.dispose();
});

test('a reused call ID terminates the Worker', async () => {
  const { instance, runtime, worker } = await harness(
    async (api) => {
      const first = api.call('model', modelPayload('hello'));
      worker.emitCall('c1', 'model', JSON.stringify(modelPayload('hello')));
      await first.catch(() => '');
      return okResult('x');
    },
    { hello: { id: 'a', text: 'x' } },
  );
  const { runId } = await instance.start({ prompt: 'hello' });
  await collect(instance.events(runId));
  expect(worker.terminated).toBe(true);
  await runtime.dispose();
});

test('a Worker exit during a run fails the run unavailable', async () => {
  const latch = createMockLatch();
  const { instance, runtime, worker } = await harness(
    async (api) => {
      await api.call('model', modelPayload('slow')).catch(() => '');
      await new Promise<void>(() => {});
      return okResult('never');
    },
    { slow: { id: 'a', text: 'late', wait: latch } },
  );
  const { runId } = await instance.start({ prompt: 'slow' });
  await latch.entered;
  worker.emit({ v: 1, kind: 'exit', code: 2 });
  expect(last(await collect(instance.events(runId)))).toMatchObject({
    error: { code: 'unavailable' },
  });
  await runtime.dispose();
});

test('a prompt above the bridge limit fails unsupported without reaching the program', async () => {
  const { instance, runtime, worker } = await harness(async () => okResult('unreachable'), {});
  const { runId } = await instance.start({ prompt: 'x'.repeat(1_048_577) });
  expect(last(await collect(instance.events(runId)))).toMatchObject({
    type: 'error',
    error: { code: 'unsupported' },
  });
  expect(worker.received).toEqual([]);
  await runtime.dispose();
});

test('a reply that mirrors raw tool calls into additional_kwargs still serves the checked calls', async () => {
  const seen: unknown[] = [];
  const { instance, runtime } = await harness(
    async (api) => {
      const tools = [
        {
          type: 'function',
          function: { name: 'search', parameters: { type: 'object', properties: {} } },
        },
      ];
      seen.push(
        JSON.parse(await api.call('model', modelPayload('hello', { tools }))) as {
          content: string;
        },
      );
      return okResult('done');
    },
    {
      hello: {
        id: 'a',
        text: '',
        toolCalls: [{ id: 'call-1', name: 'search', args: { query: 'paris' } }],
      },
    },
    {},
    vi.fn(async () => ({ hits: 2 })),
    (model) => {
      const invoke = model.invoke.bind(model);
      model.invoke = (async (...input: Parameters<typeof invoke>) => {
        const reply = await invoke(...input);
        reply.additional_kwargs['tool_calls'] = [
          { id: 'call-1', type: 'function', function: { name: 'search', arguments: '{}' } },
        ];
        return reply;
      }) as typeof model.invoke;
    },
  );
  const { runId } = await instance.start({ prompt: 'hello' });
  expect(last(await collect(instance.events(runId)))).toMatchObject({ output: 'done' });
  expect(seen).toHaveLength(1);
  await runtime.dispose();
});
