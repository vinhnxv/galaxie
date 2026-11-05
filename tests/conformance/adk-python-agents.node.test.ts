// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createRuntime, defineAgentDefinition, type RunEvent } from '@galaxie/core';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  AIMessage,
  type BaseMessage,
  type StandardMessageStructure,
  type ToolCall,
} from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { expect, test } from 'vitest';
import { z } from 'zod';
import {
  createPythonFixture,
  missingPythonWheels,
  pythonWheelsAvailable,
} from '../../examples/rag-browser/test/support/python.node.js';
import { createPyodideAdapter } from '../../packages/adapter-pyodide/src/adapter.js';
import { MemoryRecoveryStore } from '../../packages/core/test/support/memory-recovery-store.js';
import { MemoryByteCheckpoints } from './support/memory-byte-checkpoints.js';

const header = `# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0
from google.adk.agents import LlmAgent, LoopAgent, ParallelAgent, SequentialAgent
from galaxie.adk import Executor, capability_tool, llm

PARAMETERS = {'type': 'object', 'properties': {'value': {'type': 'integer'}}, 'required': ['value']}

def branch(name, confirm=False):
    tool = capability_tool('put', 'store.put@1', PARAMETERS, 'Store a value.', require_confirmation=confirm)
    return LlmAgent(name=name, model=llm('answer'), instruction=f'Answer as {name}.', tools=[tool])

def plain(name):
    return LlmAgent(name=name, model=llm('answer'), instruction=f'Answer as {name}.')

def interaction(requests):
    return {'surfaceId': 'main', 'viewRevision': 'confirm-1', 'component': 'tests.Approval/v1', 'props': {'requests': requests}}

def paused(agent):
    # Every entry has the hook, so a refusal can only come from the agent shape.
    return Executor(agent, interaction=interaction)
`;

/** Shapes that native ADK 2.12.0 runs (test_adk_python_refused_shapes.py) and the executor refuses. */
const refusedAgents = `${header}
def parallel_pause():
    return paused(ParallelAgent(name='fanout', sub_agents=[branch('left', True), plain('right')]))

def loop_pause():
    return paused(LoopAgent(name='refine', max_iterations=2, sub_agents=[branch('worker', True)]))

def first_child_pause():
    return paused(SequentialAgent(name='pipeline', sub_agents=[branch('first', True), plain('second')]))

def transfer_pause():
    return paused(LlmAgent(
        name='router', model=llm('answer'), instruction='Route.', sub_agents=[branch('specialist', True)],
    ))

def agent_tool():
    from google.adk.tools.agent_tool import AgentTool
    return Executor(LlmAgent(
        name='root', model=llm('answer'), instruction='Delegate.', tools=[AgentTool(agent=plain('worker'))],
    ))

def workflow():
    from google.adk.workflow import Workflow
    return Executor(Workflow(name='flow', edges=[('START', plain('step'))]))

def last_child_pause():
    return paused(SequentialAgent(name='pipeline', sub_agents=[plain('first'), branch('second', True)]))

def parallel_writes():
    return Executor(ParallelAgent(name='fanout', sub_agents=[branch('left'), branch('right')]))
`;

const definition = defineAgentDefinition({
  id: 'tests/adk-python-agents',
  version: '1.0.0',
  executor: 'adk-python',
  input: z.object({ prompt: z.string() }),
  models: { answer: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' } },
  capabilities: {
    required: {
      'store.put@1': {
        kind: 'write',
        input: z.object({ value: z.number().int() }),
        output: z.object({ value: z.number().int() }),
      },
    },
  },
});

/**
 * Two branches that each write once. `arrivals` records the order in which the branches received
 * their write results, and `gate` holds a branch's turn until another branch has reached a point.
 */
class BranchModel extends BaseChatModel {
  readonly arrivals: string[] = [];
  calls = 0;
  readonly #gates = new Map<string, PromiseWithResolvers<void>>();
  round: 1 | 2 = 1;
  constructor() {
    super({});
  }
  override _llmType(): string {
    return 'adk-python-branches';
  }
  override bindTools(): this {
    return this;
  }
  #gate(name: string): PromiseWithResolvers<void> {
    let gate = this.#gates.get(name);
    if (!gate) {
      gate = Promise.withResolvers<void>();
      this.#gates.set(name, gate);
    }
    return gate;
  }
  /** Opens a fresh set of gates for the next round. */
  next(round: 1 | 2): void {
    this.round = round;
    this.arrivals.length = 0;
    this.#gates.clear();
  }
  override async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.calls++;
    const system = messages.find((message) => message.type === 'system');
    const text = typeof system?.content === 'string' ? system.content : '';
    const agent = /Your internal name is "([^"]+)"/.exec(text)?.[1];
    if (agent !== 'left' && agent !== 'right') throw new Error('The agent is unexpected.');
    const turn = messages.filter((message) => message.type === 'ai').length;
    const value = agent === 'left' ? 1 : 2;
    if (turn === 0) {
      // Round one: left writes first. Round two: right writes first, so the order is reversed.
      if (this.round === 1 && agent === 'right') await this.#gate('left-wrote').promise;
      if (this.round === 2 && agent === 'left') await this.#gate('right-done').promise;
      return reply('', [{ id: `put-${agent}`, name: 'put', args: { value } }]);
    }
    this.arrivals.push(agent);
    if (agent === 'left') {
      this.#gate('left-wrote').resolve();
      // Round one ends after both writes landed: left fails once right has its result.
      if (this.round === 1) {
        await this.#gate('right-wrote').promise;
        throw new Error('PRIVATE PROVIDER DETAIL');
      }
      return reply('left done');
    }
    this.#gate('right-wrote').resolve();
    // Let the answer cross the bridge before the other branch continues.
    const done = this.#gate('right-done');
    setTimeout(() => done.resolve(), 50);
    return reply('right done');
  }
}

function reply(text: string, toolCalls: ToolCall[] = []): ChatResult {
  return {
    generations: [
      {
        text,
        message: new AIMessage<StandardMessageStructure>({
          content: text,
          tool_calls: toolCalls,
          usage_metadata: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
        }),
      },
    ],
  };
}

const bindings = {
  'store.put@1': {
    kind: 'write' as const,
    destination: 'in-browser' as const,
    timeoutMs: 1000,
    concurrency: 1,
    grantScope: 'instance' as const,
    approval: 'none' as const,
    retry: 'none' as const,
    async invoke(input: { value: number }) {
      return input;
    },
  },
};

const models = {
  providers: {
    mock: {
      destination: 'in-browser' as const,
      modality: 'text' as const,
      languages: ['en'],
      features: ['tool-calling', 'streaming'] as ('tool-calling' | 'streaming')[],
      pricing: { inputPerToken: 0, outputPerToken: 0 },
    },
  },
  roles: { answer: { providers: ['mock'], allow: ['in-browser' as const], maxTokens: 100 } },
};

test.skipIf(!pythonWheelsAvailable)(
  pythonWheelsAvailable
    ? 'ADK Python refuses shapes it cannot resume, at prepare, before any model call'
    : missingPythonWheels,
  async () => {
    const fixture = await createPythonFixture({
      framework: 'adk',
      module: 'agents',
      sources: { 'agents.py': refusedAgents },
    });
    const runtime = createRuntime({
      appId: 'adk-python-refused',
      executors: [createPyodideAdapter({ ...fixture.options, framework: 'adk' })],
      outputSafety: () => 'allow',
    });
    const model = new BranchModel();
    try {
      // The control pauses where ADK can resume it, so the hook alone does not explain a refusal.
      const control = await runtime.create(definition, {
        principalScope: 'fixture',
        agent: { ...fixture.agent, entry: 'last_child_pause' },
        services: { chatModels: { mock: model } },
        models,
        bindings,
      });
      await control.prepare();
      for (const entry of [
        'parallel_pause',
        'loop_pause',
        'first_child_pause',
        'transfer_pause',
        'agent_tool',
        'workflow',
      ]) {
        const instance = await runtime.create(definition, {
          principalScope: 'fixture',
          agent: { ...fixture.agent, entry },
          services: { chatModels: { mock: model } },
          models,
          bindings,
        });
        await expect(instance.prepare(), entry).rejects.toMatchObject({ code: 'unsupported' });
      }
      expect(model.calls).toBe(0);
      expect(fixture.workerErrors).toEqual([]);
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  },
  240000,
);

test.skipIf(!pythonWheelsAvailable)(
  pythonWheelsAvailable
    ? 'ADK Python replays each parallel branch write from its own receipt in reversed order'
    : missingPythonWheels,
  async () => {
    const fixture = await createPythonFixture({
      framework: 'adk',
      module: 'agents',
      sources: { 'agents.py': refusedAgents },
    });
    const store = { checkpoints: new MemoryByteCheckpoints(), recovery: new MemoryRecoveryStore() };
    const runtime = createRuntime({
      appId: 'adk-python-parallel-writes',
      executors: [createPyodideAdapter({ ...fixture.options, framework: 'adk' })],
      budgets: { steps: 20, toolCalls: 10, tokens: 5000 },
      outputSafety: () => 'allow',
    });
    const model = new BranchModel();
    const invoked: number[] = [];
    async function run(instance: Awaited<ReturnType<typeof runtime.create>>) {
      const { runId } = await instance.start({ prompt: 'store both' });
      const result: { output?: unknown; error?: { code: string } } = {};
      for await (const event of instance.events(runId) as AsyncIterable<RunEvent>) {
        if (event.type === 'output') result.output = event.output;
        else if (event.type === 'error') result.error = event.error;
      }
      return result;
    }
    try {
      const instance = await runtime.create(definition, {
        principalScope: 'fixture',
        agent: { ...fixture.agent, entry: 'parallel_writes' },
        recovery: store.recovery,
        services: { chatModels: { mock: model }, checkpoints: store.checkpoints },
        models,
        bindings: {
          'store.put@1': {
            kind: 'write',
            destination: 'in-browser',
            timeoutMs: 1000,
            concurrency: 2,
            grantScope: 'instance',
            approval: 'none',
            retry: 'none',
            async invoke(input: { value: number }) {
              invoked.push(input.value);
              return input;
            },
          },
        },
      });
      await instance.prepare();
      // Round one: left writes, then right writes, then the model fails after both receipts exist.
      model.next(1);
      expect((await run(instance)).error?.code).toBe('unavailable');
      expect([...invoked].sort()).toEqual([1, 2]);
      expect(model.arrivals).toEqual(['left', 'right']);
      expect(store.recovery.journal.size).toBe(2);
      expect([...store.recovery.journal.values()].map((record) => record.status)).toEqual([
        'succeeded',
        'succeeded',
      ]);
      // Round two re-dispatches the same prompt; right's write is now requested first.
      model.next(2);
      const second = await run(instance);
      expect(second.error).toBeUndefined();
      expect(['left done', 'right done']).toContain(second.output);
      expect(model.arrivals).toEqual(['right', 'left']);
      // Each write found its own receipt: nothing ran twice, and no new receipt was created.
      expect([...invoked].sort()).toEqual([1, 2]);
      expect(store.recovery.journal.size).toBe(2);
      expect(fixture.workerErrors).toEqual([]);
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  },
  240000,
);
