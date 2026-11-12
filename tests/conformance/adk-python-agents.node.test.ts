// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  createRuntime,
  defineAgentDefinition,
  type PendingInteraction,
  type RunEvent,
  type RunId,
  type SessionId,
} from '@galaxie-ai/core';
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
import { autoApprove, confirmationsFor } from './support/auto-confirm.js';
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

/** Supported and refused shapes, with native evidence in the ADK Python shape tests. */
const agents = `${header}
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

def parallel_two_pauses():
    return paused(ParallelAgent(name='fanout', sub_agents=[branch('left', True), branch('right', True)]))

def parallel_long_running():
    tool = capability_tool('put', 'store.put@1', PARAMETERS, 'Start a write.', long_running=True)
    worker = LlmAgent(name='left', model=llm('answer'), instruction='Write.', tools=[tool])
    return paused(ParallelAgent(name='fanout', sub_agents=[worker, plain('right')]))

def sequence_write_pause():
    return paused(SequentialAgent(name='pipeline', sub_agents=[branch('writer'), branch('approver', True), plain('tail')]))

def parallel_write_pause():
    fanout = ParallelAgent(name='fanout', sub_agents=[branch('left', True), branch('right')])
    return paused(SequentialAgent(name='pipeline', sub_agents=[fanout, plain('merger')]))

def duplicate_names():
    return Executor(SequentialAgent(name='root', sub_agents=[
        SequentialAgent(name='first', sub_agents=[plain('worker')]),
        SequentialAgent(name='second', sub_agents=[plain('worker')]),
    ]))
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
      sources: { 'agents.py': agents },
    });
    const runtime = createRuntime({
      appId: 'adk-python-refused',
      executors: [createPyodideAdapter({ ...fixture.options, framework: 'adk' })],
      outputSafety: () => 'allow',
    });
    const model = new BranchModel();
    try {
      for (const entry of ['last_child_pause', 'first_child_pause', 'parallel_pause']) {
        const accepted = await runtime.create(definition, {
          principalScope: 'fixture',
          agent: { ...fixture.agent, entry },
          services: { chatModels: { mock: model } },
          models,
          bindings,
        });
        await accepted.prepare();
      }
      for (const entry of [
        'duplicate_names',
        'loop_pause',
        'transfer_pause',
        'agent_tool',
        'workflow',
        'parallel_two_pauses',
        'parallel_long_running',
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

type ResumeScenario =
  | 'sequence'
  | 'parallel-sibling-first'
  | 'parallel-pause-first'
  | 'sequence-retry';

/** Script each agent by its own history, including the same turn after a failed resume. */
class ResumeModel extends BaseChatModel {
  readonly calls: string[] = [];
  readonly order: string[] = [];
  readonly #siblingDone = Promise.withResolvers<void>();
  readonly #pausedCall = Promise.withResolvers<void>();
  readonly #scenario: ResumeScenario;
  #fail: boolean;
  constructor(scenario: ResumeScenario) {
    super({});
    this.#scenario = scenario;
    this.#fail = scenario === 'sequence-retry';
  }
  override _llmType(): string {
    return 'adk-python-resume-writes';
  }
  override bindTools(): this {
    return this;
  }
  override async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const system = messages.find((message) => message.type === 'system');
    const text = typeof system?.content === 'string' ? system.content : '';
    const agent = /Your internal name is "([^"]+)"/.exec(text)?.[1];
    if (!agent) throw new Error('The agent is missing.');
    this.calls.push(agent);
    if (agent === 'tail' || agent === 'merger') return reply(`${agent} done`);
    const sibling = agent === 'writer' || agent === 'right';
    const turn = messages.filter((message) => message.type === 'ai').length;
    if (turn === 0) {
      if (agent === 'left' && this.#scenario === 'parallel-sibling-first')
        await this.#siblingDone.promise;
      if (agent === 'right' && this.#scenario === 'parallel-pause-first')
        await this.#pausedCall.promise;
      this.order.push(`${agent}-call`);
      if (!sibling) this.#pausedCall.resolve();
      return reply('', [{ id: `put-${agent}`, name: 'put', args: { value: sibling ? 1 : 2 } }]);
    }
    if (!sibling && this.#fail) {
      this.#fail = false;
      throw new Error('PRIVATE RESUME PROVIDER DETAIL');
    }
    this.order.push(`${agent}-done`);
    if (sibling) this.#siblingDone.resolve();
    return reply(`${agent} done`);
  }
}

for (const scenario of [
  'sequence',
  'parallel-sibling-first',
  'parallel-pause-first',
  'sequence-retry',
] as const) {
  test.skipIf(!pythonWheelsAvailable)(
    pythonWheelsAvailable
      ? `ADK Python invokes each workflow write once across reload (${scenario})`
      : missingPythonWheels,
    async () => {
      const fixture = await createPythonFixture({
        framework: 'adk',
        module: 'agents',
        sources: { 'agents.py': agents },
      });
      const parallel = scenario.startsWith('parallel-');
      const model = new ResumeModel(scenario);
      const invoked: number[] = [];
      const store = {
        checkpoints: new MemoryByteCheckpoints(),
        recovery: new MemoryRecoveryStore(),
      };
      const create = () =>
        createRuntime({
          appId: 'adk-python-workflow-writes',
          executors: [createPyodideAdapter({ ...fixture.options, framework: 'adk' })],
          budgets: { steps: 20, toolCalls: 10, tokens: 5000 },
          outputSafety: () => 'allow',
        });
      let runtime = create();
      let stopApproving = (): void => {};
      async function open(sessionId?: SessionId) {
        const instance = await runtime.create(definition, {
          principalScope: 'fixture',
          agent: {
            ...fixture.agent,
            entry: parallel ? 'parallel_write_pause' : 'sequence_write_pause',
          },
          ...(sessionId === undefined ? {} : { sessionId }),
          recovery: store.recovery,
          confirmations: confirmationsFor(['store.put@1'], 'adk-python-workflow-writes-v1'),
          services: { chatModels: { mock: model }, checkpoints: store.checkpoints },
          models,
          ui: {
            surfaces: ['main'],
            components: {
              'tests.Approval/v1': { actions: { approve: { payload: z.unknown() } } },
            },
          },
          bindings: {
            'store.put@1': {
              ...bindings['store.put@1'],
              approval: 'confirm',
              concurrency: 2,
              async invoke(input: { value: number }) {
                invoked.push(input.value);
                model.order.push(input.value === 1 ? 'sibling-write' : 'approved-write');
                return input;
              },
            },
          },
        });
        await instance.prepare();
        stopApproving = autoApprove(instance);
        return instance;
      }
      async function collect(
        instance: Awaited<ReturnType<typeof open>>,
        runId: RunId,
        stopAtPause = false,
      ): Promise<{ pending?: PendingInteraction; output?: unknown; error?: { code: string } }> {
        const result: { pending?: PendingInteraction; output?: unknown; error?: { code: string } } =
          {};
        for await (const event of instance.events(runId)) {
          if (event.type === 'output') result.output = event.output;
          else if (event.type === 'error') result.error = event.error;
          else if (event.type === 'interaction' && stopAtPause) {
            result.pending = event.interaction;
            break;
          }
        }
        return result;
      }
      try {
        const first = await open();
        const started = await first.start({ prompt: 'write before and after approval' });
        const paused = await collect(first, started.runId, true);
        expect(paused.error).toBeUndefined();
        expect(paused.pending).toBeDefined();
        expect(invoked).toEqual([1]);
        if (scenario === 'parallel-sibling-first')
          expect(model.order.indexOf('sibling-write')).toBeLessThan(
            model.order.indexOf('left-call'),
          );
        if (scenario === 'parallel-pause-first')
          expect(model.order.indexOf('left-call')).toBeLessThan(
            model.order.indexOf('sibling-write'),
          );
        const sessionId = first.sessionId;
        const pausedRows = structuredClone([...store.checkpoints.rows.values()]);
        stopApproving();
        await runtime.dispose();
        runtime = create();
        const second = await open(sessionId);
        const restored = await second.restore();
        if (!restored) throw new Error('The workflow pause was not restored.');
        const pending = second.getSnapshot().run?.pending;
        expect(pending).toEqual(paused.pending);
        if (!pending) throw new Error('The restored interaction is missing.');
        expect(
          await second.dispatch({
            instanceId: second.instanceId,
            runId: restored.runId,
            ...pending,
            action: 'approve',
            payload: { indexes: [0] },
          }),
        ).toMatchObject({ status: 'accepted' });
        let completed = await collect(second, restored.runId);
        if (scenario === 'sequence-retry') {
          expect(completed.error).toMatchObject({ code: 'unavailable' });
          expect(invoked).toEqual([1, 2]);
          // The failed resume wrote no checkpoint: the same pending pause remains durable.
          expect([...store.checkpoints.rows.values()]).toEqual(pausedRows);
          expect(await store.recovery.submissions(sessionId)).toMatchObject([
            { status: 'accepted' },
          ]);
          stopApproving();
          await runtime.dispose();
          runtime = create();
          const third = await open(sessionId);
          // Core retries the durable accepted answer without asking the user to submit it again.
          const retry = await third.restore();
          if (!retry) throw new Error('The failed resume could not be retried.');
          completed = await collect(third, retry.runId);
        }
        expect(completed.error).toBeUndefined();
        expect(completed.output).toBe(parallel ? 'merger done' : 'tail done');
        expect(invoked).toEqual([1, 2]);
        expect(store.recovery.journal.size).toBe(2);
        expect([...store.recovery.journal.values()].map((record) => record.status)).toEqual([
          'succeeded',
          'succeeded',
        ]);
        expect(
          model.calls.filter((agent) => agent === (parallel ? 'right' : 'writer')),
        ).toHaveLength(2);
        expect(
          model.calls.filter((agent) => agent === (parallel ? 'left' : 'approver')),
        ).toHaveLength(scenario === 'sequence-retry' ? 3 : 2);
        expect(
          model.calls.filter((agent) => agent === (parallel ? 'merger' : 'tail')),
        ).toHaveLength(1);
        expect(fixture.counts.created).toBe(scenario === 'sequence-retry' ? 3 : 2);
        expect(fixture.workerErrors).toEqual([]);
      } finally {
        stopApproving();
        await runtime.dispose();
        await fixture.cleanup();
      }
    },
    240000,
  );
}

test.skipIf(!pythonWheelsAvailable)(
  pythonWheelsAvailable
    ? 'ADK Python replays each parallel branch write from its own receipt in reversed order'
    : missingPythonWheels,
  async () => {
    const fixture = await createPythonFixture({
      framework: 'adk',
      module: 'agents',
      sources: { 'agents.py': agents },
    });
    const store = { checkpoints: new MemoryByteCheckpoints(), recovery: new MemoryRecoveryStore() };
    // Content-free diagnostics explain a first-round failure whose public error is a fixed message.
    const diagnostics: unknown[] = [];
    const runtime = createRuntime({
      appId: 'adk-python-parallel-writes',
      executors: [createPyodideAdapter({ ...fixture.options, framework: 'adk' })],
      budgets: { steps: 20, toolCalls: 10, tokens: 5000 },
      outputSafety: () => 'allow',
      diagnostics: (event) => diagnostics.push(event),
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
    let stopApproving = (): void => {};
    try {
      const instance = await runtime.create(definition, {
        principalScope: 'fixture',
        agent: { ...fixture.agent, entry: 'parallel_writes' },
        recovery: store.recovery,
        // A model-chosen write runs only behind a host confirmation, approved below as it appears.
        confirmations: confirmationsFor(['store.put@1'], 'adk-python-agents-v1'),
        services: { chatModels: { mock: model }, checkpoints: store.checkpoints },
        models,
        bindings: {
          'store.put@1': {
            kind: 'write',
            destination: 'in-browser',
            timeoutMs: 1000,
            concurrency: 2,
            grantScope: 'instance',
            approval: 'confirm',
            retry: 'none',
            async invoke(input: { value: number }) {
              invoked.push(input.value);
              return input;
            },
          },
        },
      });
      await instance.prepare();
      stopApproving = autoApprove(instance);
      // Round one: left writes, then right writes, then the model fails after both receipts exist.
      model.next(1);
      // Match against the serialized error so a failure prints the whole error, message included.
      const first = JSON.stringify((await run(instance)).error);
      expect(
        first,
        `diagnostics: ${JSON.stringify(diagnostics, (_key, value) => (value instanceof Error ? { name: value.name, message: value.message } : value))}; worker errors: ${JSON.stringify(fixture.workerErrors)}`,
      ).toMatch(/"code":"unavailable"/);
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
      stopApproving();
      await runtime.dispose();
      await fixture.cleanup();
    }
  },
  240000,
);
