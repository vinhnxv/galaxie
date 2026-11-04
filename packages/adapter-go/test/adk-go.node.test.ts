// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { createRuntime, defineAgentDefinition, type RunEvent } from '@galaxie/core';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import { createMockLatch, MockChatModel } from '../../models/src/mock.js';
import { createGoAdapter, type GoAgent } from '../src/index.js';
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
) {
  const worker = new FakeGoWorker(program, workerOptions);
  const model = new MockChatModel(script);
  adjust(model);
  const runtime = createRuntime({
    appId: 'adk-go-test',
    executors: [createGoAdapter({ createWorker: () => worker })],
    outputSafety: () => 'allow',
  });
  const instance = await runtime.create(definition, {
    principalScope: 'fixture',
    agent,
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

test('a streaming request is unsupported and the program sees a fixed code', async () => {
  let code = '';
  const { instance, runtime } = await harness(
    async (api) => {
      await api.call('model', modelPayload('hello', { stream: true })).catch((error: Error) => {
        code = error.message;
      });
      return okResult('after');
    },
    { hello: { id: 'a', text: 'x' } },
  );
  const { runId } = await instance.start({ prompt: 'hello' });
  await collect(instance.events(runId));
  expect(code).toBe('unsupported');
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
