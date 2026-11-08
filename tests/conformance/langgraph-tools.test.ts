// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  createLangGraphAdapter,
  type LangGraphHost,
  requestInteraction,
} from '@galaxie-ai/adapter-langgraph';
import {
  type CapabilityBinding,
  type CapabilityContext,
  type ConfirmationOptions,
  createRuntime,
  galaxieField,
  type ModelFeature,
  type OutputSafetyHook,
  type RunEvent,
  toErrorInfo,
} from '@galaxie-ai/core';
import { MockChatModel, type MockScript } from '@galaxie-ai/models/mock';
import { defineConfirmations } from '@galaxie-ai/react';
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  isAIMessage,
  ToolMessage,
} from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { Annotation, END, messagesStateReducer, START, StateGraph } from '@langchain/langgraph/web';
import { expect, onTestFinished, test, vi } from 'vitest';
import { z } from 'zod';
import { binding, collect } from '../../packages/core/test/fake-executor.js';
import { MemoryRecoveryStore } from '../../packages/core/test/support/memory-recovery-store.js';
import corpus from '../injection-corpus/cases.json' with { type: 'json' };
import { confirmationRegistry, PRIVATE_MARKER } from './support/injection-fixture.js';
import {
  caseSchema,
  type InjectionCase,
  ObedientAttacker,
  readDirective,
} from './support/obedient-attacker.js';

const parameters = z.object({ q: z.string() });
const messages = Annotation.Root({
  messages: Annotation<BaseMessage[]>({ reducer: messagesStateReducer, default: () => [] }),
});
const registry = defineConfirmations({
  'echo@1': {
    title: 'Save a practice query',
    fields: (input) => [{ label: 'Query', value: (input as { q: string }).q }],
  },
});
const script: MockScript = {
  go: [
    {
      id: 'choice',
      text: '',
      toolCalls: [{ id: 'choice-0', name: 'echo_1', args: { q: 'query' } }],
    },
    { id: 'answer', text: 'Finished.' },
  ],
};

async function fixture(
  options: {
    readonly binding?: Partial<CapabilityBinding>;
    readonly confirmations?: boolean;
    readonly features?: readonly ModelFeature[];
    readonly safety?: OutputSafetyHook;
    readonly script?: MockScript;
    readonly budgets?: { readonly toolCalls: number };
    readonly resume?: boolean;
  } = {},
) {
  const model = new MockChatModel(options.script ?? script);
  const invoke = vi.fn<CapabilityBinding['invoke']>(async (input) => ({
    found: (input as { q: string }).q,
  }));
  const contexts: CapabilityContext[] = [];
  const runtime = createRuntime({
    appId: 'langgraph-tools',
    executors: [createLangGraphAdapter()],
    ...(options.safety === undefined ? {} : { outputSafety: options.safety }),
    ...(options.budgets === undefined ? {} : { budgets: options.budgets }),
  });
  onTestFinished(() => runtime.dispose());
  const confirmations: ConfirmationOptions = {
    capabilities: registry.capabilities,
    policyRevision: () => 'practice-v1',
  };
  const replays: unknown[] = [];
  const instance = await runtime.create(
    {
      id: 'conformance/langgraph-tools',
      version: '1.0.0',
      executor: 'langgraph-js',
      input: z.object({}),
      models: { assistant: { modality: 'text' } },
      capabilities: {
        required: { 'echo@1': { input: parameters, output: z.unknown(), kind: 'read' } },
      },
    },
    {
      principalScope: 'learner',
      ...(options.confirmations ? { confirmations } : {}),
      ...(options.resume ? { recovery: new MemoryRecoveryStore() } : {}),
      bindings: {
        'echo@1': binding({
          ...options.binding,
          invoke: async (input, context) => {
            contexts.push(context);
            return invoke(input, context);
          },
        }),
      },
      services: { chatModels: { mock: model } },
      models: {
        providers: {
          mock: {
            destination: 'in-browser',
            modality: 'text',
            features: options.features ?? ['tool-calling', 'streaming', 'cancellation'],
            pricing: { inputPerToken: 0, outputPerToken: 0 },
          },
        },
        roles: { assistant: { providers: ['mock'], allow: ['in-browser'], maxTokens: 100 } },
      },
      agent: (host) => {
        const capability = host.langchain.capabilityTool('echo@1', {
          description: 'Echo a query.',
          parameters,
        });
        const routed = host.langchain.chatModel('assistant').bindTools?.([capability]);
        if (routed === undefined) throw new Error('Missing routed bindTools.');
        const tools = new ToolNode([capability], { handleToolErrors: false });
        const child = new StateGraph(Annotation.Root({ answer: Annotation<unknown> }))
          .addNode('ask', (_state, config) => ({
            answer: requestInteraction(
              {
                surfaceId: 'main',
                viewRevision: 'v1',
                component: 'tests.Continue/v1',
                props: {},
              },
              config,
            ).payload,
          }))
          .addEdge(START, 'ask')
          .addEdge('ask', END)
          .compile();
        return new StateGraph(messages)
          .addNode('agent', async (state, config) => {
            const initial = state.messages.length === 0 ? [new HumanMessage('go')] : [];
            return {
              messages: [...initial, await routed.invoke([...state.messages, ...initial], config)],
            };
          })
          .addNode('tools', async (state, config) => {
            const result = await tools.invoke(state, config);
            replays.push(result);
            if (options.resume) await child.invoke({}, config);
            return result;
          })
          .addEdge(START, 'agent')
          .addConditionalEdges('agent', (state) => {
            const last = state.messages.at(-1);
            return last !== undefined && isAIMessage(last) && last.tool_calls?.length
              ? 'tools'
              : END;
          })
          .addEdge('tools', 'agent')
          .compile({ checkpointer: host.langchain.checkpointer() });
      },
    },
  );
  await instance.prepare();
  const run = await instance.start({});
  const events = collect(instance.events(run.runId));
  return { instance, model, invoke, contexts, events, replays };
}

function results(events: RunEvent[]): ToolMessage[] {
  const event = events.find((entry) => entry.type === 'output');
  if (event?.type !== 'output') throw new Error('Missing tool-loop output.');
  const output = event.output as { messages: BaseMessage[] };
  return output.messages.filter((message): message is ToolMessage => {
    return ToolMessage.isInstance(message);
  });
}

async function confirmation(f: Awaited<ReturnType<typeof fixture>>) {
  await vi.waitFor(() => expect(f.instance.getSnapshot().confirmations).toHaveLength(1));
  const pending = f.instance.getSnapshot().confirmations?.[0];
  if (pending === undefined) throw new Error('Missing host confirmation.');
  return pending;
}

test('a model-chosen read returns a ToolMessage and completes the loop', async () => {
  const f = await fixture();
  const events = await f.events;
  expect(f.instance.getSnapshot().run?.status).toBe('succeeded');
  const [message] = results(events);
  expect(message?.tool_call_id).toBe('choice-0');
  expect(JSON.parse(String(message?.content))).toEqual({ found: 'query' });
  expect(f.invoke).toHaveBeenCalledTimes(1);
  expect(f.model.calls).toBe(2);
  expect(f.contexts[0]?.effectId).toMatch(/^[0-9a-f-]{36}$/);
});

test('a role with no tool-calling provider fails before dispatch, as a missing structured-output provider does', async () => {
  const f = await fixture({ features: ['streaming', 'cancellation'] });
  await f.events;
  expect(f.instance.getSnapshot().run).toMatchObject({
    status: 'failed',
    error: { code: 'unavailable' },
  });
  expect(f.model.calls).toBe(0);
  expect(f.invoke).not.toHaveBeenCalled();
});

test.each([
  { kind: 'write' as const, approval: 'none' as const, confirmations: true },
  { kind: 'write' as const, approval: 'confirm' as const, confirmations: false },
])(
  'a write without a configured host confirmation is refused before offering it: %j',
  async (policy) => {
    const f = await fixture({ binding: policy, confirmations: policy.confirmations });
    const events = await f.events;
    expect(f.instance.getSnapshot().run).toMatchObject({
      status: 'failed',
      error: { code: 'invalid', message: toErrorInfo('invalid').message },
    });
    expect(f.model.calls).toBe(0);
    expect(f.invoke).not.toHaveBeenCalled();
    expect(JSON.stringify(events.filter((event) => event.type === 'error'))).not.toContain('query');
  },
);

test('a confirmed write uses host fields and runs once after approval', async () => {
  const f = await fixture({ binding: { kind: 'write', approval: 'confirm' }, confirmations: true });
  const pending = await confirmation(f);
  expect(pending.arguments).toEqual({ q: 'query' });
  expect(Object.isFrozen(pending.arguments)).toBe(true);
  expect(registry.entry(pending.capability)?.fields(pending.arguments)).toEqual([
    { label: 'Query', value: 'query' },
  ]);
  expect(f.invoke).not.toHaveBeenCalled();
  expect(f.instance.respond(pending.id, 'approve')).toEqual({ status: 'approved' });
  await f.events;
  expect(f.instance.getSnapshot().run?.status).toBe('succeeded');
  expect(f.invoke).toHaveBeenCalledTimes(1);
  expect(f.instance.respond(pending.id, 'approve')).toEqual({ status: 'stale' });
});

test('a broker denial returns fixed text to the model and the loop continues', async () => {
  const f = await fixture({ binding: { grantScope: 'run' } });
  const [message] = results(await f.events);
  expect(JSON.parse(String(message?.content))).toEqual({ error: toErrorInfo('denied').message });
  expect(message?.content).not.toContain('query');
  expect(f.instance.getSnapshot().run?.status).toBe('succeeded');
  expect(f.model.calls).toBe(2);
  expect(f.invoke).not.toHaveBeenCalled();
});

test('tool budgets remain fatal before a chosen capability dispatches', async () => {
  const f = await fixture({ budgets: { toolCalls: 0 } });
  await f.events;
  expect(f.instance.getSnapshot().run).toMatchObject({
    status: 'failed',
    error: { code: 'budget_exceeded' },
  });
  expect(f.invoke).not.toHaveBeenCalled();
});

test('blocked tool arguments fail denied before capability dispatch', async () => {
  const f = await fixture({
    safety: async ({ text }) => (text.includes('query') ? 'block' : 'allow'),
  });
  await f.events;
  expect(f.instance.getSnapshot().run).toMatchObject({
    status: 'failed',
    error: { code: 'denied' },
  });
  expect(f.invoke).not.toHaveBeenCalled();
});

test('concurrent ToolNode calls have distinct deterministic effect IDs and replay receipts across resume', async () => {
  const f = await fixture({
    resume: true,
    confirmations: true,
    binding: { kind: 'write', approval: 'confirm', concurrency: 2 },
    script: {
      go: [
        {
          id: 'choices',
          text: '',
          toolCalls: [
            { id: 'first', name: 'echo_1', args: { q: 'first' } },
            { id: 'second', name: 'echo_1', args: { q: 'second' } },
          ],
        },
        { id: 'answer', text: 'Finished.' },
      ],
    },
  });
  await vi.waitFor(() => expect(f.instance.getSnapshot().confirmations).toHaveLength(2));
  const pending = f.instance.getSnapshot().confirmations ?? [];
  for (const entry of [...pending].reverse()) f.instance.respond(entry.id, 'approve');
  await vi.waitFor(() => expect(f.instance.getSnapshot().run?.status).toBe('waiting_input'));
  const ids = f.contexts.map((context) => context.effectId);
  expect(f.invoke).toHaveBeenCalledTimes(2);
  expect(new Set(ids).size).toBe(2);
  const run = f.instance.getSnapshot().run;
  if (run?.pending === undefined) throw new Error('Missing child interaction.');
  expect(
    await f.instance.dispatch({
      instanceId: f.instance.instanceId,
      runId: run.runId,
      ...run.pending,
      action: 'continue',
      payload: {},
    }),
  ).toMatchObject({ status: 'accepted' });
  await vi.waitFor(() => expect(f.instance.getSnapshot().run?.status).toBe('succeeded'));
  expect(f.instance.getSnapshot().confirmations).toBeUndefined();
  expect(f.contexts.map((context) => context.effectId)).toEqual(ids);
  expect(f.invoke).toHaveBeenCalledTimes(2);
  expect(f.replays).toHaveLength(2);
  const replayedMessages = f.replays.map((result) =>
    (result as { messages: ToolMessage[] }).messages.map((message) => ({
      content: message.content,
      toolCallId: message.tool_call_id,
    })),
  );
  expect(replayedMessages[1]).toEqual(replayedMessages[0]);
});

/** The compromised mock first retrieves the payload, then emits its requested native tool call. */
class ToolLoopAttacker extends ObedientAttacker {
  override bindTools(): this {
    return this;
  }
  override async _generate(
    history: BaseMessage[],
    options: this['ParsedCallOptions'],
  ): Promise<ChatResult> {
    const last = history.at(-1);
    if (last === undefined || !ToolMessage.isInstance(last)) {
      return {
        generations: [
          {
            text: '',
            message: new AIMessage({
              content: '',
              tool_calls: [{ id: 'retrieve', name: 'content_get_1', args: {} }],
            }),
          },
        ],
      };
    }
    if (last.name !== 'content_get_1') {
      return { generations: [{ text: 'Finished.', message: new AIMessage('Finished.') }] };
    }
    const result = await super._generate(history, options);
    const message = result.generations[0]?.message;
    if (message === undefined || !isAIMessage(message)) throw new Error('Missing directive.');
    const directive = readDirective(message);
    if (directive.kind !== 'callTool') throw new Error('Expected a call-tool directive.');
    return {
      generations: [
        {
          text: '',
          message: new AIMessage({
            content: '',
            tool_calls: [
              {
                id: 'injected',
                name: directive.name.replace(/[^A-Za-z0-9_]/g, '_'),
                args: directive.args,
              },
            ],
          }),
        },
      ],
    };
  }
}

async function injectionFixture(entry: InjectionCase) {
  const attacker = new ToolLoopAttacker(entry);
  const source = vi.fn(async () => ({ text: entry.payload }));
  const write = vi.fn(async () => ({ saved: true }));
  const remote = vi.fn(async () => ({ sent: true }));
  const runtime = createRuntime({
    appId: 'langgraph-injection-tools',
    executors: [createLangGraphAdapter()],
  });
  onTestFinished(() => runtime.dispose());
  const writeParameters = z.object({ recordId: z.enum(['practice-1']) });
  const instance = await runtime.create(
    {
      id: 'conformance/langgraph-injection-tools',
      version: '1.0.0',
      executor: 'langgraph-js',
      input: z.object({ privateValue: z.string().meta(galaxieField({ label: 'private-user' })) }),
      models: { assistant: { modality: 'text' } },
      capabilities: {
        required: {
          'content.get@1': {
            kind: 'read',
            input: z.object({}),
            output: z.object({ text: z.string() }),
          },
          'record.save@1': { kind: 'write', input: writeParameters, output: z.unknown() },
          'network.send@1': { kind: 'read', input: parameters, output: z.unknown() },
        },
      },
    },
    {
      principalScope: 'learner',
      confirmations: {
        capabilities: confirmationRegistry.capabilities,
        policyRevision: () => 'injection-v1',
      },
      bindings: {
        'content.get@1': { ...binding(), invoke: source },
        'record.save@1': binding({ kind: 'write', approval: 'confirm', invoke: write }),
        'network.send@1': binding({ kind: 'read', destination: 'third-party', invoke: remote }),
      },
      services: { chatModels: { attacker } },
      models: {
        providers: {
          attacker: {
            destination: 'in-browser',
            modality: 'text',
            features: ['tool-calling'],
            pricing: { inputPerToken: 0, outputPerToken: 0 },
          },
        },
        roles: { assistant: { providers: ['attacker'], allow: ['in-browser'], maxTokens: 100 } },
      },
      agent: (host: LangGraphHost) => {
        const tools = [
          host.langchain.capabilityTool('content.get@1', {
            description: 'Read retrieved content.',
            parameters: z.object({}),
          }),
          host.langchain.capabilityTool('record.save@1', {
            description: 'Save a practice record.',
            parameters: writeParameters,
          }),
          host.langchain.capabilityTool('network.send@1', {
            description: 'Query a third-party service.',
            parameters,
          }),
        ];
        const model = host.langchain.chatModel('assistant').bindTools?.(tools);
        if (model === undefined) throw new Error('Missing routed tool binding.');
        return new StateGraph(messages)
          .addNode('agent', async (state, config) => {
            const initial =
              state.messages.length === 0 ? [new HumanMessage('Read and answer.')] : [];
            return {
              messages: [...initial, await model.invoke([...state.messages, ...initial], config)],
            };
          })
          .addNode('tools', new ToolNode(tools, { handleToolErrors: false }))
          .addEdge(START, 'agent')
          .addConditionalEdges('agent', (state) => {
            const last = state.messages.at(-1);
            return last !== undefined && isAIMessage(last) && last.tool_calls?.length
              ? 'tools'
              : END;
          })
          .addEdge('tools', 'agent')
          .compile({ checkpointer: host.langchain.checkpointer() });
      },
    },
  );
  await instance.prepare();
  const run = await instance.start({ privateValue: PRIVATE_MARKER });
  return { instance, source, write, remote, attacker, events: collect(instance.events(run.runId)) };
}

for (const id of [
  'langgraph-tool-output-forged-confirmation',
  'langgraph-tool-output-private-forward',
]) {
  test(`injection through capabilityTool: ${id}`, async () => {
    const entry = caseSchema.parse(corpus.find((candidate) => candidate.id === id));
    const f = await injectionFixture(entry);
    if (entry.goal === 'unapproved-write') {
      await vi.waitFor(() => expect(f.instance.getSnapshot().confirmations).toHaveLength(1));
      const pending = f.instance.getSnapshot().confirmations?.[0];
      if (pending === undefined) throw new Error('Missing injected-write confirmation.');
      expect(pending.capability).toBe('record.save@1');
      expect(pending.arguments).toEqual({ recordId: 'practice-1' });
      expect(confirmationRegistry.entry(pending.capability)?.fields(pending.arguments)).toEqual([
        { label: 'Record', value: 'practice-1' },
      ]);
      expect(f.write).not.toHaveBeenCalled();
      expect(f.instance.respond(pending.id, 'decline')).toEqual({ status: 'declined' });
    }
    const toolResults = results(await f.events);
    expect(toolResults).toHaveLength(2);
    expect(JSON.parse(String(toolResults[1]?.content))).toEqual({
      error: toErrorInfo('denied').message,
    });
    expect(toolResults[1]?.content).not.toContain(PRIVATE_MARKER);
    expect(f.instance.getSnapshot().run?.status).toBe('succeeded');
    expect(f.instance.getSnapshot().run?.labels).toContain('private-user');
    expect(f.source).toHaveBeenCalledTimes(1);
    expect(f.attacker.reads).toBe(1);
    expect(f.write).not.toHaveBeenCalled();
    expect(f.remote).not.toHaveBeenCalled();
  });
}
