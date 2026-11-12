// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import './support/adk-env.js';
import './support/bundle-csp/record-spans.js';
import {
  createRuntime,
  defineAgentDefinition,
  type ExecutorAdapter,
  type ModelRouting,
  type RunEvent,
} from '@galaxie-ai/core';
import {
  type BaseAgent,
  BaseLlm,
  FunctionTool,
  InMemoryRunner,
  isFinalResponse,
  LlmAgent,
  type LlmRequest,
  type LlmResponse,
  LoopAgent,
  ParallelAgent,
  SequentialAgent,
} from '@google/adk';
import { AIMessage } from '@langchain/core/messages';
import { afterAll, expect, test } from 'vitest';
import { z } from 'zod';
import { MemoryRecoveryStore } from '../../core/test/support/memory-recovery-store.js';
import { createAdkAdapter, pauseAdmitted, restartsSiblings } from '../src/adapter.js';
import type { AdkAgent, AdkHost } from '../src/host.js';
import { ADK_EXECUTOR_ID } from '../src/index.js';
import { defineAdkEntry } from '../src/interaction.js';
import type { SpanRecorder } from './support/bundle-csp/span-recorder.js';
import { FakeChatModel, type Reply } from './support/fixtures.js';

const recorder = Reflect.get(globalThis, 'adkSpanRecorder') as SpanRecorder;
afterAll(() => recorder.dispose());

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
  id: 'tests/adk-agents',
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
      'docs.save@1': {
        kind: 'write',
        input: z.object({ q: z.string() }),
        output: z.object({ saved: z.string() }),
      },
    },
  },
});

const searchSpec = { description: 'Search.', parameters: z.object({ q: z.string() }) };
const tagOf = (system: string): string => /role=(\w+);/.exec(system)?.[1] ?? '';
const instruction = (tag: string): string => `role=${tag}; answer briefly.`;

/** What a scripted agent does on one model turn. */
type Turn = { text: string } | { call: { name: string; args: Record<string, unknown> } };
type Script = (tag: string, turn: number, usedTool: boolean) => Turn;

interface Shape {
  readonly name: string;
  /** Builds the agent tree from a way to make a scripted LlmAgent with the shared tool. */
  readonly build: (
    make: (tag: string, extra?: Partial<ConstructorParameters<typeof LlmAgent>[0]>) => LlmAgent,
  ) => BaseAgent;
  readonly script: Script;
  /** The model requests are compared as an ordered list unless branches run in parallel. */
  readonly ordered: boolean;
  readonly output: string | readonly string[];
}

const shapes: readonly Shape[] = [
  {
    name: 'SequentialAgent',
    build: (make) =>
      new SequentialAgent({ name: 'flow', subAgents: [make('first'), make('second')] }),
    script: (tag, _turn, usedTool) =>
      tag === 'first'
        ? { text: 'one' }
        : usedTool
          ? { text: 'two' }
          : { call: { name: 'docs_search_1', args: { q: 'x' } } },
    ordered: true,
    output: 'two',
  },
  {
    name: 'LoopAgent',
    build: (make) => new LoopAgent({ name: 'loop', maxIterations: 2, subAgents: [make('looper')] }),
    script: (_tag, turn) => ({ text: `pass ${turn + 1}` }),
    ordered: true,
    output: 'pass 2',
  },
  {
    name: 'ParallelAgent',
    build: (make) => new ParallelAgent({ name: 'fan', subAgents: [make('left'), make('right')] }),
    script: (tag) => ({ text: tag === 'left' ? 'L' : 'R' }),
    ordered: false,
    output: ['L', 'R'],
  },
  {
    name: 'LlmAgent with subAgents and transfer',
    build: (make) => {
      const child = make('child');
      return make('parent', { subAgents: [child] });
    },
    script: (tag) =>
      tag === 'parent'
        ? { call: { name: 'transfer_to_agent', args: { agent_name: 'child' } } }
        : { text: 'from child' },
    ordered: true,
    output: 'from child',
  },
];

const textOfSystem = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null && 'parts' in value && Array.isArray(value.parts))
    return value.parts.map((part: { text?: string }) => part.text ?? '').join('\n');
  return '';
};

/** ADK without galaxie: a scripted model, ADK's own runner and tool. */
class NativeLlm extends BaseLlm {
  readonly requests: string[] = [];
  readonly #script: Script;
  readonly #turns = new Map<string, number>();

  constructor(script: Script) {
    super({ model: 'scripted' });
    this.#script = script;
  }

  override async *generateContentAsync(request: LlmRequest): AsyncGenerator<LlmResponse, void> {
    const tag = tagOf(textOfSystem(request.config?.systemInstruction));
    const turn = this.#turns.get(tag) ?? 0;
    this.#turns.set(tag, turn + 1);
    this.requests.push(tag);
    const usedTool = request.contents.some((content) =>
      (content.parts ?? []).some((part) => part.functionResponse?.name === 'docs_search_1'),
    );
    const step = this.#script(tag, turn, usedTool);
    yield {
      content: {
        role: 'model',
        parts: [
          'text' in step
            ? { text: step.text }
            : { functionCall: { name: step.call.name, args: step.call.args } },
        ],
      },
      turnComplete: true,
    };
  }

  override async connect(): Promise<never> {
    throw new Error('The scripted model has no live connection.');
  }
}

async function runNative(shape: Shape): Promise<{ requests: string[]; output: string }> {
  const model = new NativeLlm(shape.script);
  const tool = new FunctionTool({
    name: 'docs_search_1',
    description: searchSpec.description,
    parameters: searchSpec.parameters,
    execute: async (input: { q: string }) => ({ hit: `hit:${input.q}` }),
  });
  const agent = shape.build(
    (tag, extra = {}) =>
      new LlmAgent({ name: tag, model, instruction: instruction(tag), tools: [tool], ...extra }),
  );
  const runner = new InMemoryRunner({ agent, appName: 'native' });
  const session = await runner.sessionService.createSession({ appName: 'native', userId: 'u' });
  let output = '';
  for await (const event of runner.runAsync({
    userId: 'u',
    sessionId: session.id,
    newMessage: { role: 'user', parts: [{ text: 'go' }] },
  })) {
    const text = (event.content?.parts ?? []).map((part) => part.text ?? '').join('');
    if (event.partial !== true && isFinalResponse(event) && text !== '') output = text;
  }
  return { requests: model.requests, output };
}

const systemOf = (messages: readonly { type: string; content: unknown }[]): string =>
  textOfSystem(messages.find((message) => message.type === 'system')?.content);

interface Galaxie {
  readonly requests: string[];
  readonly output: unknown;
  readonly searches: { q: string }[];
  readonly status: string | undefined;
}

async function runGalaxie(shape: Shape): Promise<Galaxie> {
  const turns = new Map<string, number>();
  const requests: string[] = [];
  const reply: Reply = (seen) => {
    const tag = tagOf(systemOf(seen.messages));
    const turn = turns.get(tag) ?? 0;
    turns.set(tag, turn + 1);
    requests.push(tag);
    const step = shape.script(
      tag,
      turn,
      seen.messages.some((message) => message.type === 'tool'),
    );
    return 'text' in step
      ? new AIMessage({ content: step.text })
      : new AIMessage({ content: '', tool_calls: [{ id: 'call_0', ...step.call }] });
  };
  const searches: { q: string }[] = [];
  const runtime = createRuntime({
    appId: 'adk-agents',
    executors: [createAdkAdapter() as ExecutorAdapter<unknown, unknown>],
    budgets: { steps: 12, toolCalls: 10, tokens: 5000 },
  });
  const agent: AdkAgent = (host: AdkHost) =>
    shape.build(
      (tag, extra = {}) =>
        new LlmAgent({
          name: tag,
          model: host.adk.llm('agent'),
          instruction: instruction(tag),
          tools: [host.adk.capabilityTool('docs.search@1', searchSpec)],
          ...extra,
        }),
    );
  const instance = await runtime.create(definition, {
    principalScope: 'user',
    agent,
    services: { chatModels: { mock: new FakeChatModel(reply) } },
    bindings: {
      'docs.search@1': {
        kind: 'read',
        destination: 'in-browser',
        timeoutMs: 1000,
        concurrency: 2,
        grantScope: 'instance',
        approval: 'none',
        retry: 'none',
        async invoke(input: { q: string }) {
          searches.push(input);
          return { hit: `hit:${input.q}` };
        },
      },
      'docs.save@1': {
        kind: 'write',
        destination: 'in-browser',
        timeoutMs: 1000,
        concurrency: 1,
        grantScope: 'instance',
        approval: 'none',
        retry: 'none',
        async invoke(input: { q: string }) {
          return { saved: input.q };
        },
      },
    },
    models: routing,
  });
  await instance.prepare();
  const { runId } = await instance.start({ prompt: 'go' });
  const events: RunEvent[] = [];
  for await (const event of instance.events(runId)) events.push(event);
  const output = events.find((event) => event.type === 'output');
  await runtime.dispose();
  return {
    requests,
    output: output?.type === 'output' ? output.output : undefined,
    searches,
    status: events.at(-1)?.type,
  };
}

test.each(shapes)(
  '$name runs the same model requests and output natively and through galaxie',
  async (shape) => {
    const native = await runNative(shape);
    const galaxie = await runGalaxie(shape);
    expect(galaxie.status).toBe('output');
    const expected = Array.isArray(shape.output) ? shape.output : [shape.output];
    expect(expected).toContain(galaxie.output);
    expect(expected).toContain(native.output);
    if (shape.ordered) {
      expect(galaxie.requests).toEqual(native.requests);
      expect(galaxie.output).toBe(native.output);
    } else {
      expect([...galaxie.requests].sort()).toEqual([...native.requests].sort());
    }
  },
);

test('a SequentialAgent child reaches a capability tool through the broker', async () => {
  const galaxie = await runGalaxie(shapes[0] as Shape);
  expect(galaxie.searches).toEqual([{ q: 'x' }]);
});

test('parallel branches that write get their own scopes, so a re-dispatch replays each receipt', async () => {
  const writes: { q: string }[] = [];
  let crash = true;
  const wait = Promise.withResolvers<void>();
  const reply: Reply = async (seen) => {
    const tag = tagOf(systemOf(seen.messages));
    const used = seen.messages.some((message) => message.type === 'tool');
    if (used && crash) {
      // Fail only after both branches have written, as a page closing mid-run would.
      while (writes.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
      throw new Error('The simulated page closed.');
    }
    if (used) return new AIMessage({ content: `${tag} done` });
    // On the re-dispatch the right branch finishes first, so arrival order is reversed.
    if (!crash && tag === 'left') await wait.promise;
    if (!crash && tag === 'right') setTimeout(() => wait.resolve(), 20);
    return new AIMessage({
      content: '',
      tool_calls: [{ id: 'call_0', name: 'docs_save_1', args: { q: tag === 'left' ? 'L' : 'R' } }],
    });
  };
  const runtime = createRuntime({
    appId: 'adk-agents',
    executors: [createAdkAdapter() as ExecutorAdapter<unknown, unknown>],
    budgets: { steps: 12, toolCalls: 10, tokens: 5000 },
  });
  const instance = await runtime.create(definition, {
    principalScope: 'user',
    recovery: new MemoryRecoveryStore(),
    // The tool helper offers a write only behind a configured host confirmation.
    confirmations: { capabilities: ['docs.save@1'], policyRevision: () => 'adk-agents-v1' },
    agent: (host: AdkHost) =>
      new ParallelAgent({
        name: 'fan',
        subAgents: ['left', 'right'].map(
          (tag) =>
            new LlmAgent({
              name: tag,
              model: host.adk.llm('agent'),
              instruction: instruction(tag),
              tools: [
                host.adk.capabilityTool('docs.save@1', {
                  description: 'Save.',
                  parameters: z.object({ q: z.string() }),
                }),
              ],
            }),
        ),
      }),
    services: { chatModels: { mock: new FakeChatModel(reply) } },
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
          return { hit: 'unused' };
        },
      },
      'docs.save@1': {
        kind: 'write',
        destination: 'in-browser',
        timeoutMs: 1000,
        concurrency: 2,
        grantScope: 'instance',
        approval: 'confirm',
        retry: 'none',
        async invoke(input: { q: string }) {
          writes.push(input);
          return { saved: input.q };
        },
      },
    },
    models: routing,
  });
  await instance.prepare();
  // This test is about receipts, so the broker's confirmation is approved as it appears.
  const approver = setInterval(() => {
    for (const pending of instance.getSnapshot().confirmations ?? [])
      instance.respond(pending.id, 'approve');
  }, 5);
  const first = await instance.start({ prompt: 'go' });
  const firstEvents: RunEvent[] = [];
  for await (const event of instance.events(first.runId)) firstEvents.push(event);
  expect(firstEvents.at(-1)?.type).toBe('error');
  expect(writes.map((write) => write.q).sort()).toEqual(['L', 'R']);
  crash = false;
  const second = await instance.start({ prompt: 'go' });
  const secondEvents: RunEvent[] = [];
  for await (const event of instance.events(second.runId)) secondEvents.push(event);
  expect(secondEvents.at(-1)?.type).toBe('output');
  expect(writes.map((write) => write.q).sort()).toEqual(['L', 'R']);
  clearInterval(approver);
  await runtime.dispose();
});

test('natively ADK reruns the earlier siblings when a paused sub-agent resumes', async () => {
  const model = new NativeLlm((tag, _turn, usedTool) =>
    tag === 'first'
      ? { text: 'one' }
      : usedTool
        ? { text: 'two' }
        : { call: { name: 'docs_search_1', args: { q: 'x' } } },
  );
  const tool = new FunctionTool({
    name: 'docs_search_1',
    description: 'Search.',
    parameters: searchSpec.parameters,
    requireConfirmation: true,
    execute: async (input: { q: string }) => ({ hit: `hit:${input.q}` }),
  });
  const make = (tag: string): LlmAgent =>
    new LlmAgent({ name: tag, model, instruction: instruction(tag), tools: [tool] });
  const runner = new InMemoryRunner({
    agent: new SequentialAgent({ name: 'flow', subAgents: [make('first'), make('second')] }),
    appName: 'native',
  });
  const session = await runner.sessionService.createSession({ appName: 'native', userId: 'u' });
  let waiting: string | undefined;
  for await (const event of runner.runAsync({
    userId: 'u',
    sessionId: session.id,
    newMessage: { role: 'user', parts: [{ text: 'go' }] },
  }))
    for (const part of event.content?.parts ?? [])
      if (part.functionCall?.name === 'adk_request_confirmation') waiting = part.functionCall.id;
  if (waiting === undefined) throw new Error('The native run did not pause for a confirmation.');
  const before = model.requests.length;
  for await (const _event of runner.runAsync({
    userId: 'u',
    sessionId: session.id,
    newMessage: {
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: waiting,
            name: 'adk_request_confirmation',
            response: { confirmed: true },
          },
        },
      ],
    },
  }));
  expect(model.requests.slice(before)).toContain('first');
});

test('a pause inside a later sibling of a SequentialAgent or inside a LoopAgent fails unsupported', async () => {
  for (const flow of ['sequential', 'loop'] as const) {
    const reply: Reply = (seen) =>
      tagOf(systemOf(seen.messages)) === 'first'
        ? new AIMessage({ content: 'one' })
        : new AIMessage({
            content: '',
            tool_calls: [{ id: 'call_0', name: 'docs_search_1', args: { q: 'x' } }],
          });
    const runtime = createRuntime({
      appId: 'adk-agents',
      executors: [createAdkAdapter() as ExecutorAdapter<unknown, unknown>],
      budgets: { steps: 12, toolCalls: 10, tokens: 5000 },
    });
    const gated = { ...searchSpec, requireConfirmation: true };
    const instance = await runtime.create(definition, {
      principalScope: 'user',
      agent: (host: AdkHost) =>
        defineAdkEntry({
          agent:
            flow === 'sequential'
              ? new SequentialAgent({
                  name: 'flow',
                  subAgents: [
                    new LlmAgent({
                      name: 'first',
                      model: host.adk.llm('agent'),
                      instruction: instruction('first'),
                    }),
                    new LlmAgent({
                      name: 'second',
                      model: host.adk.llm('agent'),
                      instruction: instruction('second'),
                      tools: [host.adk.capabilityTool('docs.search@1', gated)],
                    }),
                  ],
                })
              : new LoopAgent({
                  name: 'loop',
                  maxIterations: 2,
                  subAgents: [
                    new LlmAgent({
                      name: 'second',
                      model: host.adk.llm('agent'),
                      instruction: instruction('second'),
                      tools: [host.adk.capabilityTool('docs.search@1', gated)],
                    }),
                  ],
                }),
          interaction: (requests) => ({
            surfaceId: 'main',
            viewRevision: 'r1',
            component: 'tests.Approval/v1',
            props: { count: requests.length },
          }),
        }),
      services: { chatModels: { mock: new FakeChatModel(reply) } },
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
            return { hit: 'unused' };
          },
        },
        'docs.save@1': {
          kind: 'write',
          destination: 'in-browser',
          timeoutMs: 1000,
          concurrency: 1,
          grantScope: 'instance',
          approval: 'none',
          retry: 'none',
          async invoke(input: { q: string }) {
            return { saved: input.q };
          },
        },
      },
      models: routing,
    });
    await instance.prepare();
    const { runId } = await instance.start({ prompt: 'go' });
    const events: RunEvent[] = [];
    for await (const event of instance.events(runId)) events.push(event);
    const failed = events.at(-1);
    expect(failed?.type).toBe('error');
    expect(failed?.type === 'error' ? failed.error.code : undefined).toBe('unsupported');
    expect(events.some((event) => event.type === 'interaction')).toBe(false);
    await runtime.dispose();
  }
});

test('the resume rule follows ADK: only a restart through first children is safe', () => {
  const llm = (name: string, subAgents: LlmAgent[] = []): LlmAgent =>
    new LlmAgent({ name, instruction: name, subAgents });
  const flow = (name: string, ...subAgents: BaseAgent[]): SequentialAgent =>
    new SequentialAgent({ name, subAgents });
  // A lone agent, and a chain of LlmAgents, resume directly at the paused agent.
  expect(restartsSiblings(llm('solo'), 'solo')).toBe(false);
  expect(restartsSiblings(llm('p', [llm('c')]), 'c')).toBe(false);
  // The first child of a SequentialAgent, nested or not, restarts nothing that already ran.
  expect(restartsSiblings(flow('s', llm('a'), llm('b')), 'a')).toBe(false);
  expect(restartsSiblings(flow('s1', flow('s2', llm('a'), llm('b')), llm('c')), 'a')).toBe(false);
  // A later sibling, or a sibling inside a later child, would run earlier work again.
  expect(restartsSiblings(flow('s', llm('a'), llm('b')), 'b')).toBe(true);
  expect(restartsSiblings(flow('s1', llm('a'), flow('s2', llm('b'), llm('c'))), 'b')).toBe(true);
  // A sub-agent under an LlmAgent that sits inside a workflow cannot be resumed directly.
  expect(restartsSiblings(flow('s', llm('p', [llm('c')]), llm('x')), 'c')).toBe(true);
  expect(restartsSiblings(llm('root', []), 'nobody')).toBe(true);
  // A loop always restarts from its first child; duplicate names cannot be told apart.
  expect(
    restartsSiblings(new LoopAgent({ name: 'loop', maxIterations: 2, subAgents: [llm('a')] }), 'a'),
  ).toBe(true);
  expect(restartsSiblings(flow('s', llm('x'), flow('t', llm('y'), llm('x'))), 'x')).toBe(true);
});

test('pause admission shares the live and restore position rule and requires one known author', () => {
  const llm = (name: string, subAgents: LlmAgent[] = []): LlmAgent =>
    new LlmAgent({ name, instruction: name, subAgents });
  const seq = (name: string, ...subAgents: BaseAgent[]): SequentialAgent =>
    new SequentialAgent({ name, subAgents });
  const cases: { root: BaseAgent; author: string; admitted: boolean; parallel?: boolean }[] = [
    { root: llm('solo'), author: 'solo', admitted: true },
    { root: llm('parent', [llm('child')]), author: 'child', admitted: true },
    { root: seq('s', llm('a'), llm('b')), author: 'a', admitted: true },
    { root: seq('s', seq('t', llm('a'), llm('b')), llm('c')), author: 'a', admitted: true },
    { root: seq('s', llm('a'), llm('b'), llm('c')), author: 'b', admitted: false },
    { root: seq('s', llm('a'), llm('b')), author: 'b', admitted: false },
    { root: new LoopAgent({ name: 'loop', subAgents: [llm('a')] }), author: 'a', admitted: false },
    { root: llm('solo'), author: 'unknown', admitted: false },
    { root: seq('s', llm('b'), seq('t', llm('b'))), author: 'b', admitted: false },
    {
      root: seq('s', llm('a'), new ParallelAgent({ name: 'par', subAgents: [llm('b')] })),
      author: 'a',
      parallel: true,
      admitted: false,
    },
  ];
  for (const { root, author, admitted, parallel = false } of cases) {
    expect(pauseAdmitted(root, parallel, author)).toBe(admitted);
    if (!parallel) expect(pauseAdmitted(root, false, author)).toBe(!restartsSiblings(root, author));
    expect(pauseAdmitted(root, parallel, undefined)).toBe(false);
  }
});
