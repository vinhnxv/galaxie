// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import './support/adk-env.js';
import './support/bundle-csp/record-spans.js';
import {
  createRuntime,
  defineAgentDefinition,
  type ExecutorAdapter,
  GalaxieError,
  type ModelRouting,
  type RunEvent,
} from '@galaxie/core';
import { LlmAgent, SequentialAgent } from '@google/adk';
import { AIMessage } from '@langchain/core/messages';
import { afterAll, afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { createAdkAdapter } from '../src/adapter.js';
import type { AdkAgent } from '../src/host.js';
import { ADK_EXECUTOR_ID } from '../src/index.js';
import type { SpanRecorder } from './support/bundle-csp/span-recorder.js';
import { FakeChatModel, type Reply } from './support/fixtures.js';

const recorder = Reflect.get(globalThis, 'adkSpanRecorder') as SpanRecorder;
afterAll(() => recorder.dispose());
afterEach(() => vi.restoreAllMocks());

const CANARY_PROMPT = 'canary-prompt-4e1a';
const CANARY_REPLY = 'canary-reply-7b20';
const CANARY_ARGUMENT = 'canary-argument-c931';
const CANARY_RESULT = 'canary-result-02fd';

const routing: ModelRouting = {
  providers: {
    mock: {
      destination: 'in-browser',
      modality: 'text',
      languages: ['en'],
      features: ['tool-calling', 'structured-output'],
      pricing: { inputPerToken: 0, outputPerToken: 0 },
    },
  },
  roles: { agent: { providers: ['mock'], allow: ['in-browser'], maxTokens: 100 } },
};

const definition = defineAgentDefinition({
  id: 'tests/adk',
  version: '1.0.0',
  executor: ADK_EXECUTOR_ID,
  input: z.object({ prompt: z.string() }),
  models: { agent: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' } },
  capabilities: {
    required: {
      'docs.search@1': {
        kind: 'read',
        input: z.object({ q: z.string() }),
        output: z.object({ hit: z.string() }),
      },
    },
  },
});

interface Setup {
  readonly reply: Reply;
  readonly steps?: number;
  readonly invoke?: (input: { q: string }, signal: AbortSignal) => Promise<{ hit: string }>;
  readonly agent?: AdkAgent;
  readonly outputSafety?: (event: { readonly text: string }) => 'allow' | 'block';
}

async function execute(setup: Setup) {
  const model = new FakeChatModel(setup.reply);
  const invocations: { q: string }[] = [];
  const adapter = createAdkAdapter();
  const runtime = createRuntime({
    appId: 'adk-tests',
    executors: [adapter as ExecutorAdapter<unknown, unknown>],
    budgets: { steps: setup.steps ?? 8, toolCalls: 10, tokens: 5000 },
    ...(setup.outputSafety === undefined
      ? {}
      : { outputSafety: (event) => setup.outputSafety?.(event) ?? 'allow' }),
  });
  const agent: AdkAgent =
    setup.agent ??
    ((host) =>
      new LlmAgent({
        name: 'agent',
        model: host.adk.llm('agent'),
        instruction: 'Answer briefly.',
        tools: [
          host.adk.capabilityTool('docs.search@1', {
            description: 'Search the documents.',
            parameters: z.object({ q: z.string() }),
          }),
        ],
      }));
  const instance = await runtime.create(definition, {
    principalScope: 'user',
    agent,
    services: { chatModels: { mock: model } },
    bindings: {
      'docs.search@1': {
        kind: 'read',
        destination: 'in-browser',
        timeoutMs: 1000,
        concurrency: 1,
        grantScope: 'instance',
        approval: 'none',
        retry: 'none',
        async invoke(input: { q: string }, context: { signal: AbortSignal }) {
          invocations.push(input);
          return setup.invoke ? setup.invoke(input, context.signal) : { hit: CANARY_RESULT };
        },
      },
    },
    models: routing,
  });
  await instance.prepare();
  const run = async (prompt: string, onEvent?: (event: RunEvent) => Promise<void>) => {
    const { runId } = await instance.start({ prompt });
    const events: RunEvent[] = [];
    for await (const event of instance.events(runId)) {
      events.push(event);
      await onEvent?.(event);
    }
    return { runId, events };
  };
  return { adapter, runtime, instance, model, invocations, run };
}

const last = (events: readonly RunEvent[]): RunEvent | undefined => events.at(-1);
const call = (name: string, args: Record<string, unknown>) => ({ id: 'call_0', name, args });
const toolThenText =
  (final: string): Reply =>
  (seen) =>
    seen.messages.some((message) => message.type === 'tool')
      ? new AIMessage({ content: final })
      : new AIMessage({ content: '', tool_calls: [call('docs_search_1', { q: 'x' })] });

test('the adapter reports adk-js and the stage A2 features, and runs a text agent', async () => {
  const { adapter, runtime, run } = await execute({
    reply: () => new AIMessage({ content: 'hello' }),
  });
  expect(adapter.id).toBe('adk-js');
  expect(adapter.features).toEqual({
    interrupts: false,
    resume: false,
    checkpoints: false,
    streaming: false,
    subgraphs: false,
  });
  const { events } = await run('hi');
  expect(last(events)).toMatchObject({ type: 'output', output: 'hello' });
  expect(events.some((event) => event.type === 'stream')).toBe(false);
  await runtime.dispose();
});

test('one capability tool call then a final answer calls the broker once', async () => {
  const { runtime, run, invocations } = await execute({ reply: toolThenText('found it') });
  const { events } = await run('look it up');
  expect(last(events)).toMatchObject({ type: 'output', output: 'found it' });
  expect(invocations).toEqual([{ q: 'x' }]);
  await runtime.dispose();
});

test('an exhausted step limit fails budget_exceeded, never a succeeded run', async () => {
  const { runtime, run, invocations } = await execute({
    steps: 2,
    reply: () =>
      new AIMessage({ content: '', tool_calls: [call('docs_search_1', { q: 'again' })] }),
  });
  const { events } = await run('loop');
  expect(last(events)).toMatchObject({ type: 'error', error: { code: 'budget_exceeded' } });
  expect(events.some((event) => event.type === 'output')).toBe(false);
  expect(invocations.length).toBeLessThanOrEqual(2);
  await runtime.dispose();
});

test('a denied reply and an unavailable provider fail the run with their codes', async () => {
  const denied = await execute({
    reply: () => new AIMessage({ content: 'BLOCKED_TEXT' }),
    outputSafety: ({ text }) => (text.includes('BLOCKED_TEXT') ? 'block' : 'allow'),
  });
  expect(last((await denied.run('hi')).events)).toMatchObject({
    type: 'error',
    error: { code: 'denied' },
  });
  await denied.runtime.dispose();
  const unavailable = await execute({
    reply: () => {
      throw new Error('provider exploded at https://internal.example/v1');
    },
  });
  const { events } = await unavailable.run('hi');
  expect(last(events)).toMatchObject({ type: 'error', error: { code: 'unavailable' } });
  expect(JSON.stringify(events)).not.toContain('internal.example');
  await unavailable.runtime.dispose();
});

test('a stray ADK error event with no recorded failure fails unavailable', async () => {
  const { runtime, run } = await execute({
    reply: () => new AIMessage({ content: 'unused' }),
    agent: (host) =>
      new LlmAgent({
        name: 'agent',
        model: host.adk.llm('agent'),
        instruction: 'x',
        beforeModelCallback: () => ({ errorCode: 'CALLBACK', errorMessage: 'stray text' }),
      }),
  });
  const { events } = await run('hi');
  expect(last(events)).toMatchObject({ type: 'error', error: { code: 'unavailable' } });
  expect(JSON.stringify(events)).not.toContain('stray text');
  await runtime.dispose();
});

test('a capability that fails with a fatal code ends the run with it and is not repeated', async () => {
  const { runtime, run, invocations, model } = await execute({
    reply: toolThenText('unused'),
    invoke: async () => {
      throw new GalaxieError('unavailable', 'db.internal refused');
    },
  });
  const { events } = await run('go');
  expect(last(events)).toMatchObject({ type: 'error', error: { code: 'unavailable' } });
  expect(invocations).toHaveLength(1);
  expect(model.seen).toHaveLength(1);
  await runtime.dispose();
});

function latch() {
  const entered = Promise.withResolvers<void>();
  return {
    entered: entered.promise,
    async wait(signal: AbortSignal | undefined): Promise<void> {
      entered.resolve();
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  };
}

test('abort during a model call settles as cancelled and the instance runs again', async () => {
  const gate = latch();
  let blocking = true;
  const { runtime, run, instance } = await execute({
    reply: async (seen) => {
      if (blocking) await gate.wait(seen.options['signal'] as AbortSignal | undefined);
      return new AIMessage({ content: 'second run' });
    },
  });
  const { runId } = await instance.start({ prompt: 'first' });
  await gate.entered;
  await instance.cancel(runId);
  const cancelled: RunEvent[] = [];
  for await (const event of instance.events(runId)) cancelled.push(event);
  expect(last(cancelled)?.type).toBe('cancelled');
  blocking = false;
  const { events } = await run('second');
  expect(last(events)).toMatchObject({ type: 'output', output: 'second run' });
  await runtime.dispose();
});

test('abort during a tool call settles as cancelled', async () => {
  const gate = latch();
  const { runtime, instance } = await execute({
    reply: toolThenText('unused'),
    invoke: async (_input, signal) => {
      await gate.wait(signal);
      return { hit: 'unused' };
    },
  });
  const { runId } = await instance.start({ prompt: 'go' });
  await gate.entered;
  await instance.cancel(runId);
  const events: RunEvent[] = [];
  for await (const event of instance.events(runId)) events.push(event);
  expect(last(events)?.type).toBe('cancelled');
  await runtime.dispose();
});

test('a sequential agent runs two LlmAgents and returns the last answer', async () => {
  const { runtime, run } = await execute({
    reply: (seen) => new AIMessage({ content: `turn ${seen.messages.length}` }),
    agent: (host) =>
      new SequentialAgent({
        name: 'flow',
        subAgents: ['first', 'second'].map(
          (name) => new LlmAgent({ name, model: host.adk.llm('agent'), instruction: name }),
        ),
      }),
  });
  const { events } = await run('hi');
  expect(last(events)).toMatchObject({ type: 'output' });
  await runtime.dispose();
});

test('an output key returns the session state value, parsed as the schema', async () => {
  const { runtime, run } = await execute({
    reply: () => new AIMessage({ content: '{"answer":"42"}' }),
    agent: (host) =>
      new LlmAgent({
        name: 'agent',
        model: host.adk.llm('agent'),
        instruction: 'Return JSON.',
        outputSchema: z.object({ answer: z.string() }),
        outputKey: 'result',
      }),
  });
  const { events } = await run('hi');
  expect(last(events)).toMatchObject({ type: 'output', output: { answer: '42' } });
  await runtime.dispose();
});

test('a tool that needs a confirmation fails unsupported instead of succeeding with no output', async () => {
  const { runtime, run, invocations } = await execute({
    reply: toolThenText('unused'),
    agent: (host) =>
      new LlmAgent({
        name: 'agent',
        model: host.adk.llm('agent'),
        instruction: 'x',
        tools: [
          host.adk.capabilityTool('docs.search@1', {
            description: 'Search the documents.',
            parameters: z.object({ q: z.string() }),
            requireConfirmation: true,
          }),
        ],
      }),
  });
  const { events } = await run('go');
  expect(last(events)).toMatchObject({ type: 'error', error: { code: 'unsupported' } });
  expect(events.some((event) => event.type === 'output')).toBe(false);
  expect(invocations).toHaveLength(0);
  await runtime.dispose();
});

test('function-call IDs stay unique across agents and across runs of one session', async () => {
  const ids: string[] = [];
  const { runtime, run } = await execute({
    reply: (seen) =>
      seen.messages.at(-1)?.type === 'tool'
        ? new AIMessage({ content: 'done' })
        : new AIMessage({ content: '', tool_calls: [call('docs_search_1', { q: 'x' })] }),
    agent: (host) => {
      const tool = host.adk.capabilityTool('docs.search@1', {
        description: 'Search the documents.',
        parameters: z.object({ q: z.string() }),
      });
      const llm = host.adk.llm('agent');
      const generate = llm.generateContentAsync.bind(llm);
      llm.generateContentAsync = async function* (request, stream, signal) {
        for await (const response of generate(request, stream, signal)) {
          for (const part of response.content?.parts ?? [])
            if (part.functionCall?.id !== undefined) ids.push(part.functionCall.id);
          yield response;
        }
      };
      return new SequentialAgent({
        name: 'flow',
        subAgents: ['first', 'second'].map(
          (name) => new LlmAgent({ name, model: llm, instruction: name, tools: [tool] }),
        ),
      });
    },
  });
  await run('one');
  await run('two');
  expect(ids.length).toBeGreaterThanOrEqual(4);
  expect(new Set(ids).size).toBe(ids.length);
  await runtime.dispose();
});

test('prepare rejects an invalid factory, invalid services and a foreign tree', async () => {
  const adapter = createAdkAdapter();
  const options = { signal: new AbortController().signal };
  await expect(adapter.prepare('nope' as never, { chatModels: {} }, options)).rejects.toMatchObject(
    {
      code: 'invalid',
    },
  );
  await expect(
    adapter.prepare(() => undefined as never, { chatModels: 1 } as never, options),
  ).rejects.toMatchObject({
    code: 'invalid',
  });
  await expect(
    adapter.prepare(
      () => new LlmAgent({ name: 'agent', model: 'gemini-2.5-flash', instruction: 'x' }),
      { chatModels: {} },
      options,
    ),
  ).rejects.toMatchObject({ code: 'unsupported' });
});

test('the run configuration comes only from the adapter', async () => {
  const seen: { stream: boolean | undefined }[] = [];
  let hostKeys: string[] = [];
  const { runtime, run } = await execute({
    reply: () => new AIMessage({ content: 'ok' }),
    agent: (host) => {
      hostKeys = [...Object.keys(host), ...Object.keys(host.adk)];
      const llm = host.adk.llm('agent');
      const generate = llm.generateContentAsync.bind(llm);
      llm.generateContentAsync = (request, stream, signal) => {
        seen.push({ stream });
        return generate(request, stream, signal);
      };
      return new LlmAgent({ name: 'agent', model: llm, instruction: 'x' });
    },
  });
  await run('hi');
  expect(seen).toEqual([{ stream: false }]);
  expect(hostKeys.sort()).toEqual(['adk', 'capabilities', 'capabilityTool', 'llm', 'requestInput']);
  await runtime.dispose();
});

test('a canary in the prompt, reply, arguments and results appears in no log, event, error or span', async () => {
  const sinks: string[] = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const)
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      sinks.push(JSON.stringify(args));
    });
  const { runtime, run } = await execute({
    reply: (seen) =>
      seen.messages.some((message) => message.type === 'tool')
        ? new AIMessage({ content: CANARY_REPLY })
        : new AIMessage({
            content: '',
            tool_calls: [call('docs_search_1', { q: CANARY_ARGUMENT })],
          }),
  });
  const { events } = await run(CANARY_PROMPT);
  const serialized = JSON.stringify(events);
  expect(last(events)).toMatchObject({ type: 'output', output: CANARY_REPLY });
  for (const canary of [CANARY_PROMPT, CANARY_ARGUMENT, CANARY_RESULT])
    expect(serialized).not.toContain(canary);
  await runtime.dispose();
  const spans = JSON.stringify(recorder.spans());
  const logs = sinks.join('\n');
  for (const canary of [CANARY_PROMPT, CANARY_REPLY, CANARY_ARGUMENT, CANARY_RESULT]) {
    expect(spans).not.toContain(canary);
    expect(logs).not.toContain(canary);
  }
  expect(recorder.spans().map((span) => span.name)).toEqual(
    expect.arrayContaining(['galaxie.node adk.run', 'call_llm']),
  );
});
