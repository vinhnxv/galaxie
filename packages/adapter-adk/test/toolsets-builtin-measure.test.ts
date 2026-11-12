// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import './support/adk-env.js';
import {
  createRuntime,
  defineAgentDefinition,
  type ExecutorAdapter,
  type ModelRouting,
  type RunEvent,
} from '@galaxie-ai/core';
import {
  BaseLlm,
  type BaseTool,
  BaseToolset,
  BuiltInCodeExecutor,
  BuiltInPlanner,
  EnterpriseWebSearchTool,
  FunctionTool,
  GoogleMapsGroundingTool,
  GoogleSearchTool,
  InMemoryRunner,
  isFinalResponse,
  LlmAgent,
  type LlmRequest,
  type LlmResponse,
  ParallelAgent,
  PlanReActPlanner,
  SequentialAgent,
  UrlContextTool,
  VertexAiSearchTool,
  WebMCPToolset,
} from '@google/adk';
import { AIMessage } from '@langchain/core/messages';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { createAdkAdapter, restartsSiblings } from '../src/adapter.js';
import { type AdkHost, createHost } from '../src/host.js';
import { openAiTools } from '../src/llm.js';
import { validateAgentTree } from '../src/validate.js';
import { FakeChatModel, fakeModels, fakeRun } from './support/fixtures.js';

/* T-js ALTERNATIVE: fixed registered-list expansion preserves declarations,
 * pause position and native results. GT5 fails: the public helper does not exist.
 * GT4 membership refuses neighbours. AL-T is static only.
 * N-js REFUSED: GN1 fails, but provider config is rejected, not silently lost.
 * GN2 not measured after GN1; GN3 passes for every web builtin family.
 * X-js REFUSED: GX1 has no isolation seam in the web executor surface; GX2 not
 * measured after GX1; builtin refusal passes. Native Node-only executors absent.
 * L-js REFUSED: GL1 final retagging differs; GL2 not measured after GL1;
 * both prepare refusals pass. AL-L fails under the unchanged tagged script.
 */
const preparation = { roles: ['answer'], providers: { mock: { credential: false } } };
const parameters = z.object({ value: z.number() });
class StaticTools extends BaseToolset {
  readonly fixed: readonly BaseTool[];
  constructor(fixed: readonly BaseTool[]) {
    super([]);
    this.fixed = fixed;
  }
  override async getTools(): Promise<BaseTool[]> {
    return [...this.fixed];
  }
  override async close(): Promise<void> {}
}

test('fixed test-local expansion preserves the pause-position rules', () => {
  const provider = new FakeChatModel(() => new AIMessage({ content: 'unused' }));
  const { host, registry } = createHost(
    { chatModels: { mock: provider } },
    preparation,
    () => undefined,
    () => 's',
  );
  const gated = host.adk.capabilityTool('math.double@1', {
    description: 'Double.',
    parameters,
    requireConfirmation: true,
  });
  const fixed = Object.freeze([gated]);
  const group = new StaticTools(fixed);
  registry.tools.add(group);
  try {
    const expanded = [...group.fixed];
    expect(expanded).toEqual([gated]);
    expect(expanded.every((tool) => registry.tools.has(tool))).toBe(true);
    const leaf = new LlmAgent({ name: 'leaf', model: host.adk.llm('answer'), tools: expanded });
    const root = new SequentialAgent({
      name: 'root',
      subAgents: [new LlmAgent({ name: 'first', model: host.adk.llm('answer') }), leaf],
    });
    expect(() => validateAgentTree(root, registry)).not.toThrow();
    expect(restartsSiblings(root, 'leaf')).toBe(true);
    const parallelLeaf = new LlmAgent({
      name: 'other',
      model: host.adk.llm('answer'),
      tools: [...group.fixed],
    });
    expect(
      restartsSiblings(new ParallelAgent({ name: 'parallel', subAgents: [parallelLeaf] }), 'other'),
    ).toBe(true);
    expect(provider.seen).toHaveLength(0);
  } finally {
    registry.tools.delete(group);
  }
});

for (const [name, extra] of Object.entries({
  search: { tools: [new GoogleSearchTool()] },
  url: { tools: [new UrlContextTool()] },
  vertex: {
    tools: [
      new VertexAiSearchTool({
        dataStoreId:
          'projects/test/locations/global/collections/default_collection/dataStores/test',
      }),
    ],
  },
  maps: { tools: [new GoogleMapsGroundingTool()] },
  enterprise: { tools: [new EnterpriseWebSearchTool()] },
  webmcp: { tools: [new WebMCPToolset()] },
  static: { tools: [new StaticTools([])] },
  authorFetch: {
    tools: [
      new FunctionTool({
        name: 'fetch_page',
        description: 'Fetch.',
        execute: async () => fetch('https://example.invalid'),
      }),
    ],
  },
  executor: { codeExecutor: new BuiltInCodeExecutor() },
  thinking: { planner: new BuiltInPlanner({ thinkingConfig: {} }) },
  react: { planner: new PlanReActPlanner() },
})) {
  test(`${name} stays refused by real prepare with zero model and capability requests`, async () => {
    const provider = new FakeChatModel(() => new AIMessage({ content: 'unused' }));
    await expect(
      createAdkAdapter().prepare(
        (host) => new LlmAgent({ name: 'root', model: host.adk.llm('answer'), ...extra }),
        { chatModels: { mock: provider } },
        { signal: new AbortController().signal, models: preparation },
      ),
    ).rejects.toMatchObject({ code: 'unsupported' });
    expect(provider.seen).toHaveLength(0);
  });
}

test('provider tool configuration is refused by the conversion backstop', () => {
  expect(
    openAiTools({
      model: 'scripted',
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
      config: {},
    }),
  ).toEqual([]);
  for (const tool of [{ googleSearch: {} }, { codeExecution: {} }]) {
    expect(() =>
      openAiTools({
        model: 'scripted',
        contents: [],
        toolsDict: {},
        liveConnectConfig: {},
        config: { tools: [tool] },
      }),
    ).toThrow(expect.objectContaining({ code: 'unsupported' }));
  }
});

const definition = (write: boolean) =>
  defineAgentDefinition({
    id: 'tests/adk-toolset-replacement',
    version: '1.0.0',
    executor: 'adk-js',
    input: z.object({ prompt: z.string() }),
    models: { answer: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' } },
    capabilities: {
      required: {
        'math.double@1': { kind: write ? 'write' : 'read', input: parameters, output: parameters },
      },
    },
  });
const routing: ModelRouting = {
  providers: {
    mock: {
      destination: 'in-browser',
      modality: 'text',
      languages: ['en'],
      features: ['tool-calling'],
      pricing: { inputPerToken: 0, outputPerToken: 0 },
    },
  },
  roles: { answer: { providers: ['mock'], allow: ['in-browser'], maxTokens: 100 } },
};

async function alternative(grouped: boolean, replyText = 'done', write = false) {
  const calls: unknown[] = [];
  const provider = new FakeChatModel((_, index) =>
    index === 0
      ? new AIMessage({
          content: '',
          tool_calls: [{ id: 'call', name: 'double', args: { value: 21 } }],
        })
      : new AIMessage({ content: replyText }),
  );
  const runtime = createRuntime({
    appId: 'spike',
    executors: [createAdkAdapter() as ExecutorAdapter<unknown, unknown>],
  });
  let approver: ReturnType<typeof setInterval> | undefined;
  try {
    const instance = await runtime.create(definition(write), {
      principalScope: 'user',
      services: { chatModels: { mock: provider } },
      models: routing,
      ...(write
        ? { confirmations: { capabilities: ['math.double@1'], policyRevision: () => 'spike-v1' } }
        : {}),
      agent: (host: AdkHost) => {
        const tool = host.adk.capabilityTool('math.double@1', {
          toolName: 'double',
          description: 'Double.',
          parameters,
        });
        const tools = grouped ? [...new StaticTools(Object.freeze([tool])).fixed] : [tool];
        return new LlmAgent({ name: 'root', model: host.adk.llm('answer'), tools });
      },
      bindings: {
        'math.double@1': {
          kind: write ? 'write' : 'read',
          destination: 'in-browser',
          timeoutMs: 1000,
          concurrency: 1,
          grantScope: 'instance',
          approval: write ? 'confirm' : 'none',
          retry: 'none',
          invoke: async (input: { value: number }) => {
            calls.push(input);
            return { value: input.value * 2 };
          },
        },
      },
    });
    await instance.prepare();
    if (write)
      approver = setInterval(() => {
        for (const pending of instance.getSnapshot().confirmations ?? [])
          instance.respond(pending.id, 'approve');
      }, 5);
    const { runId } = await instance.start({ prompt: 'question' });
    const events: RunEvent[] = [];
    for await (const event of instance.events(runId)) events.push(event);
    return {
      output: events.filter((event) => event.type === 'output').map((event) => event.output),
      calls,
      schemas: provider.seen.map((call) => call.toolSchemas),
    };
  } finally {
    if (approver !== undefined) clearInterval(approver);
    await runtime.dispose();
  }
}

test('a flat host capability list matches a native toolset under the unchanged script', async () => {
  const nativeCalls: unknown[] = [];
  const schemas: unknown[] = [];
  const tool = new FunctionTool({
    name: 'double',
    description: 'Double.',
    parameters,
    execute: async (input) => {
      nativeCalls.push(input);
      return { value: input.value * 2 };
    },
  });
  class Scripted extends BaseLlm {
    turn = 0;
    constructor() {
      super({ model: 'scripted' });
    }
    override async *generateContentAsync(request: LlmRequest): AsyncGenerator<LlmResponse, void> {
      schemas.push(openAiTools(request).map((entry) => entry.function));
      yield {
        content: {
          role: 'model',
          parts:
            this.turn++ === 0
              ? [{ functionCall: { name: 'double', args: { value: 21 } } }]
              : [{ text: 'done' }],
        },
        turnComplete: true,
      };
    }
    override async connect(): Promise<never> {
      throw new Error('No live connection.');
    }
  }
  const runner = new InMemoryRunner({
    agent: new LlmAgent({ name: 'root', model: new Scripted(), tools: [new StaticTools([tool])] }),
    appName: 'spike',
  });
  const session = await runner.sessionService.createSession({ appName: 'spike', userId: 'user' });
  const output: string[] = [];
  for await (const event of runner.runAsync({
    userId: 'user',
    sessionId: session.id,
    newMessage: { role: 'user', parts: [{ text: 'question' }] },
  }))
    if (isFinalResponse(event))
      output.push(event.content?.parts?.map((part) => part.text ?? '').join('') ?? '');
  const flat = await alternative(false);
  expect(flat).toEqual({ output, calls: nativeCalls, schemas });
  expect(await alternative(true)).toEqual(flat);
  expect(flat.output).toEqual(['done']);
  expect(flat.calls).toEqual([{ value: 21 }]);
});

test('instructions cannot reproduce PlanReAct final retagging under the unchanged script', async () => {
  const reply = '/*PLANNING*/think/*FINAL_ANSWER*/done';
  expect((await alternative(false, reply)).output).toEqual([reply]);
  expect(reply).not.toBe('done');
});

test('the flat list and fixed expansion each invoke a confirmed host write once', async () => {
  const flat = await alternative(false, 'done', true);
  expect(await alternative(true, 'done', true)).toEqual(flat);
  expect(flat.output).toEqual(['done']);
  expect(flat.calls).toEqual([{ value: 21 }]);
});

test('thinking configuration does not reach the routed model options', async () => {
  const provider = new FakeChatModel(() => new AIMessage({ content: 'done' }));
  const { run } = fakeRun(fakeModels().port);
  const { host } = createHost(
    { chatModels: { mock: provider } },
    preparation,
    () => run,
    () => 's',
  );
  const replies = [];
  for await (const reply of host.adk.llm('answer').generateContentAsync({
    model: 'galaxie:answer',
    contents: [{ role: 'user', parts: [{ text: 'question' }] }],
    toolsDict: {},
    liveConnectConfig: {},
    config: { thinkingConfig: { thinkingBudget: 128 } },
  }))
    replies.push(reply);
  expect(replies[0]?.content?.parts?.[0]?.text).toBe('done');
  expect(provider.seen).toHaveLength(1);
  expect(provider.seen[0]?.options).not.toHaveProperty('thinkingConfig');
});

test('dynamic nested and throwing toolsets are rejected without expansion', async () => {
  let expansions = 0;
  class Dynamic extends BaseToolset {
    constructor() {
      super(() => true);
    }
    override async getTools(): Promise<BaseTool[]> {
      expansions += 1;
      throw new Error('Must not expand.');
    }
    override async close(): Promise<void> {}
  }
  const dynamic = new Dynamic();
  for (const group of [dynamic, new StaticTools([dynamic as never])]) {
    const provider = new FakeChatModel(() => new AIMessage({ content: 'unused' }));
    await expect(
      createAdkAdapter().prepare(
        (host) => new LlmAgent({ name: 'root', model: host.adk.llm('answer'), tools: [group] }),
        { chatModels: { mock: provider } },
        { signal: new AbortController().signal, models: preparation },
      ),
    ).rejects.toMatchObject({ code: 'unsupported' });
    expect(provider.seen).toHaveLength(0);
  }
  expect(expansions).toBe(0);
});
