// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import './support/adk-env.js';
import {
  createRuntime,
  defineAgentDefinition,
  type ExecutorAdapter,
  type ModelRouting,
  type RunEvent,
  type RunId,
  type SessionId,
} from '@galaxie-ai/core';
import {
  BaseLlm,
  type BaseTool,
  BaseToolset,
  EXIT_LOOP,
  FunctionTool,
  InMemoryRunner,
  isFinalResponse,
  LlmAgent,
  type LlmRequest,
  type LlmResponse,
  LoopAgent,
  ParallelAgent,
  SequentialAgent,
  WebMCPToolset,
} from '@google/adk';
import { AIMessage } from '@langchain/core/messages';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import { type AdkHost, createHost } from '../src/host.js';
import { adkToolset, createAdkAdapter, defineAdkEntry } from '../src/index.js';
import { openAiTools } from '../src/llm.js';
import { validateAgentTree } from '../src/validate.js';
import { FakeChatModel, fakeModels, fakeTrace } from './support/fixtures.js';

const preparation = { roles: ['answer'], providers: { mock: { credential: false } } };
const spec = { description: 'Read a number.', parameters: z.object({ value: z.number() }) };

function setup() {
  return createHost(
    { chatModels: { mock: new FakeChatModel(() => new AIMessage({ content: 'done' })) } },
    preparation,
    () => undefined,
    () => 's',
  );
}

test('the exported fixed toolset preserves the host inventory and expands a frozen ordered copy', async () => {
  const { host, registry } = setup();
  const first = host.adk.capabilityTool('read.first@1', { ...spec, toolName: 'first' });
  const second = host.adk.capabilityTool('read.second@1', { ...spec, toolName: 'second' });
  const source = [first, second];
  const group = adkToolset(host, source);
  source.reverse();
  expect(group).toBeInstanceOf(BaseToolset);
  expect(Object.isFrozen(group)).toBe(true);
  expect(await group.getTools()).toEqual([first, second]);
  expect(await group.getTools()).not.toBe(await group.getTools());
  (await group.getTools()).reverse();
  expect(await group.getTools()).toEqual([first, second]);
  await group.close();
  expect(() =>
    validateAgentTree(
      new LlmAgent({ name: 'root', model: host.adk.llm('answer'), tools: [group] }),
      registry,
    ),
  ).not.toThrow();
  expect([...Object.keys(host), ...Object.keys(host.adk)].sort()).toEqual([
    'adk',
    'capabilities',
    'capabilityTool',
    'llm',
    'requestInput',
  ]);
});

test('the helper refuses foreign members empty lists duplicates and malformed arguments', () => {
  const { host } = setup();
  const other = setup();
  const tool = host.adk.capabilityTool('read.first@1', spec);
  for (const members of [
    [],
    [tool, tool],
    [other.host.adk.capabilityTool('read.first@1', spec)],
    [host.adk.requestInput()],
  ])
    expect(() => adkToolset(host, members)).toThrow(
      expect.objectContaining({ code: 'unsupported' }),
    );
  expect(() => adkToolset({} as never, [tool])).toThrow(
    expect.objectContaining({ code: 'invalid' }),
  );
  expect(() => adkToolset(host, {} as never)).toThrow(expect.objectContaining({ code: 'invalid' }));
});

test('an author toolset never expands during admission', () => {
  const { host, registry } = setup();
  let expansions = 0;
  class AuthorTools extends BaseToolset {
    constructor() {
      super([]);
    }
    override async getTools(): Promise<BaseTool[]> {
      expansions += 1;
      return [];
    }
    override async close(): Promise<void> {}
  }
  expect(() =>
    validateAgentTree(
      new LlmAgent({ name: 'root', model: host.adk.llm('answer'), tools: [new AuthorTools()] }),
      registry,
    ),
  ).toThrow(expect.objectContaining({ code: 'unsupported' }));
  expect(expansions).toBe(0);
});

test.each([
  'author-tool',
  'foreign-tool',
  'foreign-toolset',
  'author-toolset',
  'network-toolset',
  'nested',
  'empty',
  'duplicate',
  'input',
  'exit',
] as const)('%s refuses before model or store requests', async (kind) => {
  const provider = new FakeChatModel(() => new AIMessage({ content: 'unused' }));
  const store = { request: vi.fn(async () => null) };
  let expansions = 0;
  class AuthorTools extends BaseToolset {
    constructor() {
      super([]);
    }
    override async getTools(): Promise<BaseTool[]> {
      expansions += 1;
      throw new Error('Must not expand.');
    }
    override async close(): Promise<void> {}
  }
  const other = setup();
  const foreign = other.host.adk.capabilityTool('math.double@1', spec);
  await expect(
    createAdkAdapter().prepare(
      (host) => {
        const own = host.adk.capabilityTool('math.double@1', spec);
        const group = adkToolset(host, [own]);
        let tools: LlmAgent['tools'];
        switch (kind) {
          case 'author-tool':
            tools = [
              adkToolset(host, [
                new FunctionTool({
                  name: 'author',
                  description: 'Unused.',
                  execute: async () => ({}),
                }),
              ]),
            ];
            break;
          case 'foreign-tool':
            tools = [adkToolset(host, [foreign])];
            break;
          case 'foreign-toolset':
            tools = [adkToolset(other.host, [foreign])];
            break;
          case 'author-toolset':
            tools = [new AuthorTools()];
            break;
          case 'network-toolset':
            tools = [new WebMCPToolset()];
            break;
          case 'nested':
            tools = [adkToolset(host, [group as never])];
            break;
          case 'empty':
            tools = [adkToolset(host, [])];
            break;
          case 'duplicate':
            tools = [adkToolset(host, [own, own])];
            break;
          case 'input':
            tools = [adkToolset(host, [host.adk.requestInput()])];
            break;
          case 'exit':
            tools = [adkToolset(host, [EXIT_LOOP as never])];
            break;
        }
        return new LlmAgent({ name: 'root', model: host.adk.llm('answer'), tools });
      },
      { chatModels: { mock: provider }, checkpoints: store },
      { signal: new AbortController().signal, models: preparation },
    ),
  ).rejects.toMatchObject({ code: 'unsupported' });
  expect(provider.seen).toEqual([]);
  expect(store.request).not.toHaveBeenCalled();
  expect(expansions).toBe(0);
});

test.each(['flat-first', 'set-first', 'two-sets'] as const)(
  'duplicate names across %s refuse at prepare',
  async (kind) => {
    const provider = new FakeChatModel(() => new AIMessage({ content: 'unused' }));
    await expect(
      createAdkAdapter().prepare(
        (host) => {
          const first = host.adk.capabilityTool('math.first@1', { ...spec, toolName: 'same' });
          const second = host.adk.capabilityTool('math.second@1', { ...spec, toolName: 'same' });
          const tools =
            kind === 'two-sets'
              ? [adkToolset(host, [first]), adkToolset(host, [second])]
              : kind === 'set-first'
                ? [adkToolset(host, [first]), second]
                : [first, adkToolset(host, [second])];
          return new LlmAgent({ name: 'root', model: host.adk.llm('answer'), tools });
        },
        { chatModels: { mock: provider } },
        { signal: new AbortController().signal, models: preparation },
      ),
    ).rejects.toMatchObject({ code: 'unsupported' });
    expect(provider.seen).toEqual([]);
  },
);

test('admission rechecks capability names changed after fixed-list creation', () => {
  const { host, registry } = setup();
  const first = host.adk.capabilityTool('math.first@1', { ...spec, toolName: 'first' });
  const second = host.adk.capabilityTool('math.second@1', { ...spec, toolName: 'second' });
  const group = adkToolset(host, [first, second]);
  Reflect.set(second, 'name', 'first');
  expect(() =>
    validateAgentTree(
      new LlmAgent({ name: 'root', model: host.adk.llm('answer'), tools: [group] }),
      registry,
    ),
  ).toThrow(expect.objectContaining({ code: 'unsupported' }));
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

async function execute(grouped: boolean, write = false, gated = false) {
  const provider = new FakeChatModel((_, index) =>
    index === 0
      ? new AIMessage({
          content: '',
          tool_calls: [{ id: 'call', name: 'second', args: { value: 21 } }],
        })
      : new AIMessage({ content: 'done' }),
  );
  const scopes: (string | undefined)[] = [];
  const interactions: string[] = [];
  const adapter = createAdkAdapter();
  const observed: typeof adapter = {
    ...adapter,
    async prepare(...args) {
      const prepared = await adapter.prepare(...args);
      return {
        ...prepared,
        pending(_sessionId, options) {
          return prepared.pending('s' as SessionId, options);
        },
        run(request) {
          const call = request.capabilities.call.bind(request.capabilities);
          request.capabilities.call = (name, input, options) => {
            scopes.push(options?.effectScope);
            return call(name, input, options);
          };
          // Compare the executor's identities under the same session, independently of core UUIDs.
          return prepared.run({ ...request, sessionId: 's' as SessionId });
        },
      };
    },
  };
  const runtime = createRuntime({
    appId: 'fixed-toolsets',
    executors: [observed as ExecutorAdapter<unknown, unknown>],
  });
  const calls: unknown[] = [];
  let approver: ReturnType<typeof setInterval> | undefined;
  try {
    const instance = await runtime.create(
      defineAgentDefinition({
        id: 'tests/fixed-toolsets',
        version: '1.0.0',
        executor: 'adk-js',
        input: z.object({ prompt: z.string() }),
        models: { answer: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' } },
        capabilities: {
          required: {
            'math.double@1': {
              kind: write ? 'write' : 'read',
              input: spec.parameters,
              output: spec.parameters,
            },
          },
        },
      }),
      {
        principalScope: 'user',
        models: routing,
        services: { chatModels: { mock: provider } },
        ...(write
          ? { confirmations: { capabilities: ['math.double@1'], policyRevision: () => 'v1' } }
          : {}),
        agent: (host: AdkHost) => {
          const tools = ['first', 'second', 'third'].map((toolName) =>
            host.adk.capabilityTool('math.double@1', {
              ...spec,
              toolName,
              ...(gated && toolName === 'second' ? { requireConfirmation: true } : {}),
            }),
          );
          const agent = new LlmAgent({
            name: 'root',
            model: host.adk.llm('answer'),
            tools: grouped ? [...tools.slice(0, 1), adkToolset(host, tools.slice(1))] : tools,
          });
          return gated
            ? defineAdkEntry({
                agent,
                interaction: () => ({
                  surfaceId: 'main',
                  viewRevision: 'r1',
                  component: 'tests.Approval/v1',
                  props: {},
                }),
              })
            : agent;
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
            async invoke(input: { value: number }) {
              calls.push(input);
              return { value: input.value * 2 };
            },
          },
        },
      },
    );
    await instance.prepare();
    if (write)
      approver = setInterval(() => {
        for (const pending of instance.getSnapshot().confirmations ?? [])
          instance.respond(pending.id, 'approve');
      }, 5);
    const { runId } = await instance.start({ prompt: 'question' });
    const events: RunEvent[] = [];
    let cursor = 0;
    for (;;) {
      let submitted = false;
      let index = 0;
      for await (const event of instance.events(runId)) {
        if (index++ < cursor) continue;
        cursor += 1;
        events.push(event);
        if (event.type === 'interaction') {
          interactions.push(event.interaction.interactionId);
          expect(
            (
              await instance.dispatch({
                instanceId: instance.instanceId,
                runId,
                ...event.interaction,
                action: 'approve',
                payload: { indexes: [0] },
              })
            ).status,
          ).toBe('accepted');
          submitted = true;
        }
      }
      if (!submitted) break;
    }
    return {
      output: events.flatMap((event) => (event.type === 'output' ? [event.output] : [])),
      calls,
      schemas: provider.seen.map((call) => call.toolSchemas),
      scopes,
      interactions,
    };
  } finally {
    if (approver !== undefined) clearInterval(approver);
    await runtime.dispose();
  }
}

test('fixed expansion preserves native declarations order schemas results and flat-list behavior', async () => {
  const schemas: unknown[] = [];
  const calls: unknown[] = [];
  class NativeTools extends BaseToolset {
    readonly fixed: BaseTool[];
    constructor(fixed: BaseTool[]) {
      super([]);
      this.fixed = fixed;
    }
    override async getTools(): Promise<BaseTool[]> {
      return [...this.fixed];
    }
    override async close(): Promise<void> {}
  }
  class Scripted extends BaseLlm {
    turn = 0;
    constructor() {
      super({ model: 'scripted' });
    }
    override async *generateContentAsync(request: LlmRequest): AsyncGenerator<LlmResponse, void> {
      schemas.push(openAiTools(request).map((tool) => tool.function));
      yield {
        content: {
          role: 'model',
          parts:
            this.turn++ === 0
              ? [{ functionCall: { name: 'second', args: { value: 21 } } }]
              : [{ text: 'done' }],
        },
        turnComplete: true,
      };
    }
    override async connect(): Promise<never> {
      throw new Error('No live connection.');
    }
  }
  const tools = ['first', 'second', 'third'].map(
    (name) =>
      new FunctionTool({
        name,
        ...spec,
        async execute(input) {
          calls.push(input);
          return { value: input.value * 2 };
        },
      }),
  );
  const runner = new InMemoryRunner({
    appName: 'fixed-toolsets',
    agent: new LlmAgent({
      name: 'root',
      model: new Scripted(),
      tools: [...tools.slice(0, 1), new NativeTools(tools.slice(1))],
    }),
  });
  const session = await runner.sessionService.createSession({
    appName: 'fixed-toolsets',
    userId: 'user',
  });
  const output: string[] = [];
  for await (const event of runner.runAsync({
    userId: 'user',
    sessionId: session.id,
    newMessage: { role: 'user', parts: [{ text: 'question' }] },
  }))
    if (isFinalResponse(event))
      output.push(event.content?.parts?.map((part) => part.text ?? '').join('') ?? '');
  const flat = await execute(false);
  expect(flat).toMatchObject({ output, calls, schemas });
  expect(await execute(true)).toEqual(flat);
  expect(flat.output).toEqual(['done']);
  expect(flat.calls).toEqual([{ value: 21 }]);
  expect(flat.schemas[0]?.map((tool) => tool['name'])).toEqual(['first', 'second', 'third']);
});

test('a grouped confirmed host write executes once with flat-list requests and output', async () => {
  const flat = await execute(false, true);
  expect(await execute(true, true)).toEqual(flat);
  expect(flat.output).toEqual(['done']);
  expect(flat.calls).toEqual([{ value: 21 }]);
  expect(flat.scopes).toEqual(['adk/s/root/0/0']);
});

test('a grouped ADK confirmation preserves the flat-list interaction identity effect and one host write', async () => {
  const flat = await execute(false, true, true);
  expect(await execute(true, true, true)).toEqual(flat);
  expect(flat.output).toEqual(['done']);
  expect(flat.calls).toEqual([{ value: 21 }]);
  expect(flat.interactions).toHaveLength(1);
  expect(flat.scopes).toEqual(['adk/s/root/0/0']);
});

test.each(['sequential', 'loop', 'parallel'] as const)(
  'a gated fixed toolset retains the %s pause refusal',
  async (shape) => {
    const provider = new FakeChatModel((seen) =>
      seen.messages.some((message) => message.type === 'tool')
        ? new AIMessage({ content: 'done' })
        : new AIMessage({
            content: '',
            tool_calls: [{ id: 'call', name: 'gated', args: { value: 21 } }],
          }),
    );
    const prepared = await createAdkAdapter().prepare(
      (host) => {
        const leaf = new LlmAgent({
          name: 'leaf',
          model: host.adk.llm('answer'),
          tools: [
            adkToolset(host, [
              host.adk.capabilityTool('math.double@1', {
                ...spec,
                toolName: 'gated',
                requireConfirmation: true,
              }),
            ]),
          ],
        });
        const root =
          shape === 'sequential'
            ? new SequentialAgent({
                name: 'flow',
                subAgents: [new LlmAgent({ name: 'first', model: host.adk.llm('answer') }), leaf],
              })
            : shape === 'loop'
              ? new LoopAgent({ name: 'flow', maxIterations: 1, subAgents: [leaf] })
              : new ParallelAgent({ name: 'flow', subAgents: [leaf] });
        return defineAdkEntry({
          agent: root,
          interaction: () => ({
            surfaceId: 'main',
            viewRevision: 'r1',
            component: 'tests.Approval/v1',
            props: {},
          }),
        });
      },
      { chatModels: { mock: provider } },
      { signal: new AbortController().signal, models: preparation },
    );
    try {
      const events = [];
      for await (const event of prepared.run({
        runId: 'run' as RunId,
        sessionId: 's' as SessionId,
        command: { type: 'start', input: { prompt: 'question' } },
        signal: new AbortController().signal,
        trace: fakeTrace().trace,
        models: fakeModels().port,
        limits: { steps: 8 },
        capabilities: {
          async call(): Promise<never> {
            throw new Error('No capability expected.');
          },
        },
      }))
        events.push(event);
      expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'unsupported' } });
    } finally {
      await prepared.dispose();
    }
  },
);

test('a foreign toolset smuggled in after prepare is refused by the model trust check', async () => {
  const provider = new FakeChatModel(() => new AIMessage({ content: 'unused' }));
  let root: LlmAgent | undefined;
  const prepared = await createAdkAdapter().prepare(
    (host) => {
      root = new LlmAgent({ name: 'root', model: host.adk.llm('answer') });
      return root;
    },
    { chatModels: { mock: provider } },
    { signal: new AbortController().signal, models: preparation },
  );
  class Smuggled extends BaseToolset {
    constructor() {
      super([]);
    }
    override async getTools(): Promise<BaseTool[]> {
      return [
        new FunctionTool({ name: 'foreign', description: 'Unused.', execute: async () => ({}) }),
      ];
    }
    override async close(): Promise<void> {}
  }
  root?.tools.push(new Smuggled());
  try {
    const events = [];
    for await (const event of prepared.run({
      runId: 'run' as RunId,
      sessionId: 's' as SessionId,
      command: { type: 'start', input: { prompt: 'question' } },
      signal: new AbortController().signal,
      trace: fakeTrace().trace,
      models: fakeModels().port,
      limits: { steps: 8 },
      capabilities: {
        async call(): Promise<never> {
          throw new Error('No capability expected.');
        },
      },
    }))
      events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'unsupported' } });
    expect(provider.seen).toEqual([]);
  } finally {
    await prepared.dispose();
  }
});
