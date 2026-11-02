// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import './support/adk-env.js';
import {
  createRuntime,
  defineAgentDefinition,
  type ExecutorAdapter,
  type ModelRouting,
  type RunEvent,
} from '@galaxie/core';
import { LlmAgent, type LlmRequest, type LlmResponse } from '@google/adk';
import { AIMessage, AIMessageChunk } from '@langchain/core/messages';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { createAdkAdapter } from '../src/adapter.js';
import type { AdkAgent } from '../src/host.js';
import { GalaxieLlm } from '../src/llm.js';
import { MAX_DELTA_LENGTH } from '../src/stream.js';
import {
  FakeChatModel,
  type FakeModelsOptions,
  fakeModels,
  fakeRun,
  type Reply,
  wordChunks,
} from './support/fixtures.js';

const CANARY_CALL_ID = 'canary-call-id-8d2f';

function llmFor(reply: Reply, options: FakeModelsOptions = {}) {
  const model = new FakeChatModel(reply, undefined, wordChunks);
  const { port, leases } = fakeModels(options);
  const { run } = fakeRun(port);
  const llm = new GalaxieLlm({
    role: 'agent',
    providers: { mock: model },
    active: () => run,
    trusted: () => false,
  });
  return { llm, leases };
}

function chunked(chunks: AIMessageChunk[], options: FakeModelsOptions = {}) {
  const model = new FakeChatModel(
    () => new AIMessage({ content: '' }),
    undefined,
    () => chunks,
  );
  const { port, leases } = fakeModels(options);
  const { run } = fakeRun(port);
  const llm = new GalaxieLlm({
    role: 'agent',
    providers: { mock: model },
    active: () => run,
    trusted: () => false,
  });
  return { llm, leases };
}

const fragment = (args: string, extra: Record<string, unknown> = {}): AIMessageChunk =>
  new AIMessageChunk({
    content: '',
    tool_call_chunks: [{ index: 0, args, type: 'tool_call_chunk', ...extra }],
  });

async function drain(llm: GalaxieLlm): Promise<void> {
  for await (const _ of llm.generateContentAsync(ask(), true)) void _;
}

const ask = (): LlmRequest => ({
  contents: [{ role: 'user', parts: [{ text: 'go' }] }],
  config: {
    tools: [{ functionDeclarations: [{ name: 'lookup', description: 'lookup tool' }] }],
  },
  liveConnectConfig: {},
  toolsDict: {},
});

const text = (response: LlmResponse): string =>
  (response.content?.parts ?? []).map((part) => part.text ?? '').join('');

test('text deltas arrive as partial responses and the final response joins them', async () => {
  const { llm, leases } = llmFor(() => new AIMessage({ content: 'one two three' }));
  const responses: LlmResponse[] = [];
  for await (const response of llm.generateContentAsync(ask(), true)) responses.push(response);
  const partial = responses.filter((response) => response.partial === true);
  const final = responses.at(-1);
  expect(partial.map(text)).toEqual(['one ', 'two ', 'three']);
  expect(final?.partial).toBeUndefined();
  expect(text(final as LlmResponse)).toBe(partial.map(text).join(''));
  expect(final?.turnComplete).toBe(true);
  // Each growing reply is checked before its delta is yielded, then the complete reply once.
  expect(leases[0]?.checked.slice(0, 3)).toEqual(['one ', 'one two ', 'one two three']);
  expect(leases[0]?.ended).toHaveLength(1);
});

test('a tool-call turn streams no argument text and assigns galaxie call IDs', async () => {
  const { llm } = llmFor(
    () =>
      new AIMessage({
        content: 'looking',
        tool_calls: [{ id: CANARY_CALL_ID, name: 'lookup', args: { q: 'x' } }],
      }),
  );
  const responses: LlmResponse[] = [];
  for await (const response of llm.generateContentAsync(ask(), true)) responses.push(response);
  const partial = responses.filter((response) => response.partial === true);
  expect(partial.map(text)).toEqual(['looking']);
  expect(
    partial.every((response) => response.content?.parts?.every((part) => !part.functionCall)),
  ).toBe(true);
  const final = responses.at(-1);
  expect(final?.content?.parts).toEqual([
    { text: 'looking' },
    { functionCall: { id: 'galaxie-0', name: 'lookup', args: { q: 'x' } } },
  ]);
  expect(JSON.stringify(responses)).not.toContain(CANARY_CALL_ID);
});

test('a blocked delta is never yielded and the lease fails; earlier deltas stay delivered', async () => {
  const { llm, leases } = llmFor(() => new AIMessage({ content: 'fine BAD_WORD later' }), {
    block: 'BAD_WORD',
  });
  const seen: string[] = [];
  await expect(async () => {
    for await (const response of llm.generateContentAsync(ask(), true)) seen.push(text(response));
  }).rejects.toMatchObject({ code: 'denied' });
  expect(seen).toEqual(['fine ']);
  expect(leases[0]?.failed).toBe(1);
  expect(leases[0]?.ended).toEqual([]);
});

test('a consumer that stops mid-stream settles the lease once as failed', async () => {
  const { llm, leases } = llmFor(() => new AIMessage({ content: 'one two three' }));
  for await (const response of llm.generateContentAsync(ask(), true)) {
    expect(text(response)).toBe('one ');
    break;
  }
  expect(leases[0]?.failed).toBe(1);
  expect(leases[0]?.ended).toEqual([]);
});

test('an empty provider stream fails unavailable', async () => {
  const model = new FakeChatModel(
    () => new AIMessage({ content: '' }),
    undefined,
    () => [],
  );
  const { port } = fakeModels();
  const { run } = fakeRun(port);
  const llm = new GalaxieLlm({
    role: 'agent',
    providers: { mock: model },
    active: () => run,
    trusted: () => false,
  });
  await expect(async () => {
    for await (const _ of llm.generateContentAsync(ask(), true)) void _;
  }).rejects.toMatchObject({ code: 'unavailable' });
});

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
  id: 'tests/adk-stream',
  version: '1.0.0',
  executor: 'adk-js',
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

type Safety = NonNullable<Parameters<typeof createRuntime>[0]['outputSafety']>;

async function execute(reply: Reply, safety: Safety | string = () => 'allow') {
  const runtime = createRuntime({
    appId: 'adk-stream-tests',
    executors: [createAdkAdapter() as ExecutorAdapter<unknown, unknown>],
    budgets: { steps: 8, toolCalls: 10, tokens: 5000 },
    outputSafety:
      typeof safety === 'string'
        ? ({ text: reply }) => (reply.includes(safety) ? 'block' : 'allow')
        : safety,
  });
  const agent: AdkAgent = (host) =>
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
    });
  const instance = await runtime.create(definition, {
    principalScope: 'user',
    agent,
    services: { chatModels: { mock: new FakeChatModel(reply, undefined, wordChunks) } },
    bindings: {
      'docs.search@1': {
        kind: 'read',
        destination: 'in-browser',
        timeoutMs: 1000,
        concurrency: 1,
        grantScope: 'instance',
        approval: 'none',
        retry: 'none',
        async invoke() {
          return { hit: 'result-text' };
        },
      },
    },
    models: routing,
  });
  await instance.prepare();
  const run = async (
    prompt: string,
    onEvent?: (event: RunEvent, runId: string) => Promise<void>,
  ): Promise<RunEvent[]> => {
    const { runId } = await instance.start({ prompt });
    const events: RunEvent[] = [];
    for await (const event of instance.events(runId)) {
      events.push(event);
      await onEvent?.(event, runId);
    }
    return events;
  };
  return { runtime, run, cancel: (runId: string) => instance.cancel(runId as never) };
}

const streams = (events: readonly RunEvent[], mode: string) =>
  events.flatMap((event) =>
    event.type === 'stream' && event.mode === mode ? [event.data as Record<string, unknown>] : [],
  );

test('deltas arrive as messages events in order and join to the output', async () => {
  const { runtime, run } = await execute(() => new AIMessage({ content: 'alpha beta gamma' }));
  const events = await run('hi');
  expect(streams(events, 'messages').map((data) => data['text'])).toEqual([
    'alpha ',
    'beta ',
    'gamma',
  ]);
  expect(events.at(-1)).toMatchObject({ type: 'output', output: 'alpha beta gamma' });
  expect(
    events.every(
      (event) =>
        event.type !== 'stream' || (event.executor === 'adk-js' && event.path.length === 0),
    ),
  ).toBe(true);
  await runtime.dispose();
});

test('a tool turn emits updates markers with the tool name and position, never a call ID or result', async () => {
  const { runtime, run } = await execute((seen) =>
    seen.messages.some((message) => message.type === 'tool')
      ? new AIMessage({ content: 'done' })
      : new AIMessage({
          content: '',
          tool_calls: [{ id: CANARY_CALL_ID, name: 'docs_search_1', args: { q: 'secret-arg' } }],
        }),
  );
  const events = await run('hi');
  expect(streams(events, 'updates')).toEqual([
    { step: 'tool_call', tool: 'docs_search_1', index: 0 },
    { step: 'tool_result', tool: 'docs_search_1', index: 1 },
  ]);
  const wire = JSON.stringify(events.filter((event) => event.type === 'stream'));
  for (const canary of [CANARY_CALL_ID, 'secret-arg', 'result-text', 'galaxie-0'])
    expect(wire).not.toContain(canary);
  await runtime.dispose();
});

test('a mid-stream block fails the run denied and the blocked delta never reaches the host', async () => {
  const { runtime, run } = await execute(
    () => new AIMessage({ content: 'safe BLOCKED_TEXT after' }),
    'BLOCKED_TEXT',
  );
  const events = await run('hi');
  expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'denied' } });
  expect(streams(events, 'messages').map((data) => data['text'])).toEqual(['safe ']);
  expect(JSON.stringify(events)).not.toContain('BLOCKED_TEXT');
  await runtime.dispose();
});

test('a delta longer than the bound is split', async () => {
  const long = 'x'.repeat(MAX_DELTA_LENGTH + 10);
  const { runtime, run } = await execute(() => new AIMessage({ content: long }));
  const events = await run('hi');
  const texts = streams(events, 'messages').map((data) => String(data['text']));
  expect(texts.map((value) => value.length)).toEqual([MAX_DELTA_LENGTH, 10]);
  expect(texts.join('')).toBe(long);
  await runtime.dispose();
});

test('an abort mid-stream stops further deltas and settles the run as cancelled', async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let checks = 0;
  const { runtime, run, cancel } = await execute(
    () => new AIMessage({ content: 'alpha beta gamma' }),
    async (): Promise<'allow'> => {
      checks += 1;
      if (checks === 2) await gate;
      return 'allow';
    },
  );
  let cancelled = false;
  const events = await run('hi', async (event, runId) => {
    if (event.type === 'stream' && !cancelled) {
      cancelled = true;
      const stopping = cancel(runId);
      release();
      await stopping;
    }
  });
  expect(events.at(-1)?.type).toBe('cancelled');
  expect(streams(events, 'messages').map((data) => data['text'])).toEqual(['alpha ']);
  await runtime.dispose();
});

test('a stream cut off inside tool-call arguments fails invalid instead of running repaired arguments', async () => {
  const { llm, leases } = chunked([fragment('{"q":"ab', { name: 'lookup', id: 'c1' })]);
  await expect(drain(llm)).rejects.toMatchObject({ code: 'invalid' });
  expect(leases[0]?.failed).toBe(1);
});

test('argument fragments that join to complete JSON become one call', async () => {
  const { llm } = chunked([fragment('{"q":', { name: 'lookup', id: 'c1' }), fragment('"abc"}')]);
  const responses: LlmResponse[] = [];
  for await (const response of llm.generateContentAsync(ask(), true)) responses.push(response);
  expect(responses.at(-1)?.content?.parts).toEqual([
    { functionCall: { id: 'galaxie-0', name: 'lookup', args: { q: 'abc' } } },
  ]);
});

test('a complete call beside argument fragments, and an invalid call chunk, are refused', async () => {
  const whole = new AIMessageChunk({
    content: '',
    tool_calls: [{ id: 'a', name: 'lookup', args: { q: 'x' } }],
  });
  const mixed = chunked([whole, fragment('{"q":"y"}', { name: 'lookup', id: 'c1' })]);
  await expect(drain(mixed.llm)).rejects.toMatchObject({ code: 'unsupported' });
  // A provider without native streaming yields its whole reply, which may report an invalid call.
  const { port } = fakeModels();
  const { run } = fakeRun(port);
  const invalid = new GalaxieLlm({
    role: 'agent',
    providers: {
      mock: new FakeChatModel(
        () =>
          new AIMessage({
            content: '',
            invalid_tool_calls: [
              { name: 'lookup', args: '{', error: 'bad', type: 'invalid_tool_call' },
            ],
          }),
      ),
    },
    active: () => run,
    trusted: () => false,
  });
  await expect(drain(invalid)).rejects.toMatchObject({ code: 'invalid' });
});

test('a blocked call ID or argument fails denied at the check and no partial carries it', async () => {
  const byId = llmFor(
    () =>
      new AIMessage({
        content: 'ok ',
        tool_calls: [{ id: CANARY_CALL_ID, name: 'lookup', args: { q: 'x' } }],
      }),
    { block: CANARY_CALL_ID },
  );
  const seen: LlmResponse[] = [];
  await expect(async () => {
    for await (const response of byId.llm.generateContentAsync(ask(), true)) seen.push(response);
  }).rejects.toMatchObject({ code: 'denied' });
  expect(JSON.stringify(seen)).not.toContain(CANARY_CALL_ID);
  const byArgument = llmFor(
    () =>
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'c1', name: 'lookup', args: { q: 'BLOCKED_ARG' } }],
      }),
    { block: 'BLOCKED_ARG' },
  );
  await expect(drain(byArgument.llm)).rejects.toMatchObject({ code: 'denied' });
});

test('a text delta split never separates a surrogate pair', async () => {
  const text = `${'x'.repeat(MAX_DELTA_LENGTH - 1)}\u{1F600}tail`;
  const { runtime, run } = await execute(() => new AIMessage({ content: text }));
  const texts = streams(await run('hi'), 'messages').map((data) => String(data['text']));
  expect(texts.length).toBeGreaterThan(1);
  expect(texts.join('')).toBe(text);
  for (const value of texts) expect(value.isWellFormed()).toBe(true);
  await runtime.dispose();
});
