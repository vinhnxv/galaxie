// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import './support/adk-env.js';
import {
  AgentTool,
  BaseAgent,
  BaseLlm,
  BuiltInCodeExecutor,
  BuiltInPlanner,
  type Event,
  FunctionTool,
  Gemini,
  GoogleSearchTool,
  LangGraphAgent,
  LlmAgent,
  LoopAgent,
  ParallelAgent,
  RemoteAgent,
  RoutedAgent,
  SequentialAgent,
  WebMCPToolset,
  Workflow,
} from '@google/adk';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { createHost } from '../src/host.js';
import { validateAgentTree } from '../src/validate.js';
import { FakeChatModel } from './support/fixtures.js';

function setup() {
  const { host, registry } = createHost(
    {
      chatModels: {
        mock: new FakeChatModel(() => {
          throw new Error('unused');
        }),
      },
    },
    { roles: ['agent', 'other'], providers: { mock: { credential: false } } },
    () => undefined,
    () => 'conversation',
  );
  const llm = host.adk.llm('agent');
  const tool = host.adk.capabilityTool('docs.search@1', {
    description: 'Search.',
    parameters: z.object({ q: z.string() }),
  });
  const agent = (name: string, extra: Record<string, unknown> = {}): LlmAgent =>
    new LlmAgent({ name, model: llm, instruction: 'x', tools: [tool], ...extra });
  return { host, registry, llm, tool, agent };
}

const validates = (root: unknown, registry: ReturnType<typeof setup>['registry']): void =>
  validateAgentTree(root, registry);

test('SequentialAgent, ParallelAgent and LoopAgent over valid LlmAgents pass', () => {
  const { registry, agent } = setup();
  for (const Composite of [SequentialAgent, ParallelAgent, LoopAgent])
    expect(() =>
      validates(new Composite({ name: 'flow', subAgents: [agent('a'), agent('b')] }), registry),
    ).not.toThrow();
  expect(() => validates(agent('solo'), registry)).not.toThrow();
});

test('a sub-agent inherits the model of its parent agent', () => {
  const { registry, agent, llm } = setup();
  const child = new LlmAgent({ name: 'child', instruction: 'x' });
  expect(() => validates(agent('parent', { subAgents: [child] }), registry)).not.toThrow();
  expect(() =>
    validates(new LlmAgent({ name: 'orphan', instruction: 'x', model: llm }), registry),
  ).not.toThrow();
});

test('a string model, Gemini, a foreign BaseLlm and a missing model fail unsupported', () => {
  const { registry } = setup();
  class Foreign extends BaseLlm {
    constructor() {
      super({ model: 'foreign' });
    }
    // biome-ignore lint/correctness/useYield: a fixture that never produces output
    override async *generateContentAsync(): AsyncGenerator<never, void> {
      throw new Error('unused');
    }
    override async connect(): Promise<never> {
      throw new Error('unused');
    }
  }
  const models: unknown[] = [
    'gemini-2.5-flash',
    new Gemini({ model: 'gemini-2.5-flash', apiKey: 'unused' }),
    new Foreign(),
    undefined,
  ];
  for (const model of models) {
    const agent = new LlmAgent({
      name: 'agent',
      instruction: 'x',
      ...(model === undefined ? {} : { model: model as never }),
    });
    expect(() => validates(agent, registry), String(model)).toThrow(
      expect.objectContaining({ code: 'unsupported' }),
    );
  }
});

test('built-in tools, toolsets, code executors, planners and author-built tools fail unsupported', () => {
  const { registry, agent } = setup();
  const authorTool = new FunctionTool({
    name: 'leak',
    description: 'Calls out.',
    execute: async () => fetch('https://example.invalid'),
  });
  const cases: Record<string, Record<string, unknown>> = {
    search: { tools: [new GoogleSearchTool()] },
    toolset: { tools: [new WebMCPToolset()] },
    author: { tools: [authorTool] },
    executor: { codeExecutor: new BuiltInCodeExecutor() },
    planner: { planner: new BuiltInPlanner({ thinkingConfig: {} }) },
  };
  for (const [label, extra] of Object.entries(cases))
    expect(() => validates(agent(label, extra), registry), label).toThrow(
      expect.objectContaining({ code: 'unsupported' }),
    );
});

test('remote, graph, routed, workflow, custom and tool agents fail unsupported', () => {
  const { registry, agent, llm } = setup();
  class Custom extends BaseAgent {
    protected override async *runAsyncImpl(): AsyncGenerator<Event, void, void> {}
    protected override async *runLiveImpl(): AsyncGenerator<Event, void, void> {}
  }
  class Subclass extends LlmAgent {}
  const roots: Record<string, () => unknown> = {
    remote: () => new RemoteAgent({ name: 'remote', url: 'https://example.invalid' } as never),
    graph: () => new LangGraphAgent({ name: 'graph', graph: {} } as never),
    routed: () => new RoutedAgent({ name: 'routed', agents: [], router: () => undefined }),
    workflow: () => new Workflow({ name: 'workflow', dynamicEntry: () => undefined }),
    custom: () => new Custom({ name: 'custom' }),
    subclass: () => new Subclass({ name: 'sub', model: llm, instruction: 'x' }),
    agentTool: () => agent('tools', { tools: [new AgentTool({ agent: agent('inner') })] }),
  };
  for (const [label, make] of Object.entries(roots)) {
    const root = make();
    expect(() => validates(root, registry), label).toThrow(
      expect.objectContaining({ code: 'unsupported' }),
    );
  }
});

test('a sub-agent with a disallowed model fails even when the root is valid', () => {
  const { registry, agent } = setup();
  const bad = new LlmAgent({ name: 'bad', instruction: 'x', model: 'gemini-2.5-flash' });
  expect(() =>
    validates(new SequentialAgent({ name: 'flow', subAgents: [agent('good'), bad] }), registry),
  ).toThrow(expect.objectContaining({ code: 'unsupported' }));
  expect(() => validates({}, registry)).toThrow(expect.objectContaining({ code: 'unsupported' }));
  expect(() => validates(undefined, registry)).toThrow(
    expect.objectContaining({ code: 'invalid' }),
  );
});

test('a model or tool from another host is not trusted', () => {
  const first = setup();
  const second = setup();
  expect(() => validates(first.agent('a'), second.registry)).toThrow(
    expect.objectContaining({ code: 'unsupported' }),
  );
});
