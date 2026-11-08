// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  createLangGraphAdapter,
  gateDecision,
  requestInteraction,
} from '@galaxie-ai/adapter-langgraph';
import {
  type AgentInstance,
  type AgentSnapshot,
  type CapabilityBinding,
  createRuntime,
  type DecisionResult,
  type DiagnosticEvent,
  defineAgentDefinition,
  galaxieField,
  type RunEvent,
  type RunId,
  type ViewRevision,
} from '@galaxie-ai/core';
import { MockChatModel } from '@galaxie-ai/models/mock';
import {
  type ConfirmationRegistry,
  createRegistry,
  defineComponent,
  defineConfirmations,
} from '@galaxie-ai/react';
import { createMcpServer, type McpEvent } from '@galaxie-ai/tools-mcp';
import {
  Annotation,
  END,
  isGraphInterrupt,
  MemorySaver,
  START,
  StateGraph,
} from '@langchain/langgraph/web';
import { createElement } from 'react';
import { type Mock, type MockInstance, onTestFinished, vi } from 'vitest';
import { z } from 'zod';
import { binding, collect } from '../../../packages/core/test/fake-executor.js';
import { createSpanRecorder, serializeSpans } from '../../../packages/core/test/span-tree.js';
import { MCP_ORIGIN, type McpFixture } from './mcp-context.js';
import {
  type InjectionCase,
  ObedientAttacker,
  ObedientDecisionAttacker,
  readDirective,
} from './obedient-attacker.js';

export const PRIVATE_MARKER: string = 'synthetic-private-corpus-value-3a9f';
export const decisionQuestionText: string = 'Would you like to continue with this practice record?';
export const outputSchema: z.ZodType<{ answered: boolean }> = z.object({ answered: z.boolean() });
export const confirmationRegistry: ConfirmationRegistry = defineConfirmations({
  'record.save@1': {
    title: 'Save practice record',
    fields: (args) => [{ label: 'Record', value: (args as { recordId: string }).recordId }],
  },
});
const registry = createRegistry({
  urlAllowlist: ['https://example.test'],
  components: [
    defineComponent({
      id: 'tests.CorpusAsk/v1',
      props: z.object({ text: z.string() }),
      actions: {
        continue: { label: 'Continue', payload: z.object({}) },
        stop: { label: 'Stop', payload: z.object({}) },
      },
      component: ({ props }) => createElement('span', null, props.text),
    }),
    defineComponent({
      id: 'tests.CorpusLink/v1',
      props: z.object({ url: z.string(), text: z.string() }),
      actions: { continue: { label: 'Continue', payload: z.object({}) } },
      urls: (props) => [props.url],
      component: ({ props }) => createElement('span', null, props.text),
    }),
  ],
});

export interface InjectionResult {
  readonly events: RunEvent[];
  readonly snapshot: AgentSnapshot<unknown>;
  readonly spans: string;
}
export interface InjectionFixture {
  readonly instance: AgentInstance<{ privateValue: string; probe: boolean }, unknown>;
  readonly content: Mock<CapabilityBinding['invoke']>;
  readonly write: Mock<CapabilityBinding['invoke']>;
  readonly remote: MockInstance<MockChatModel['_generate']>;
  readonly remoteModel: MockChatModel;
  readonly attacker: ObedientAttacker;
  readonly decisionAttacker: ObedientDecisionAttacker;
  readonly diagnostics: DiagnosticEvent[];
  readonly errors: unknown[];
  readonly snapshots: AgentSnapshot<unknown>[];
  readonly recorder: ReturnType<typeof createSpanRecorder>;
  readonly mcpEvents: McpEvent[];
  readonly mcpInvokes: MockInstance<CapabilityBinding['invoke']>[];
  dispose(): Promise<void>;
  start(probe?: boolean): Promise<{ runId: RunId; events: Promise<RunEvent[]> }>;
  run(probe?: boolean): Promise<InjectionResult>;
}

export async function createInjectionFixture(
  entry: InjectionCase,
  mcp?: McpFixture,
): Promise<InjectionFixture> {
  const diagnostics: DiagnosticEvent[] = [];
  const errors: unknown[] = [];
  const snapshots: AgentSnapshot<unknown>[] = [];
  const mcpEvents: McpEvent[] = [];
  const recorder = createSpanRecorder();
  const attacker = new ObedientAttacker(entry);
  const decisionAttacker = new ObedientDecisionAttacker(entry);
  const remoteModel = new MockChatModel({
    [PRIVATE_MARKER]: { id: 'remote', text: 'Unexpected remote answer.' },
  });
  const remote = vi.spyOn(remoteModel, '_generate');
  const content = vi.fn<CapabilityBinding['invoke']>(async () => ({ text: entry.payload }));
  const write = vi.fn<CapabilityBinding['invoke']>(async () => ({ saved: true }));
  const server =
    mcp === undefined
      ? undefined
      : createMcpServer({
          id: 'lessons',
          url: mcp.url,
          destination: 'user-device',
          token: () => mcp.token,
          fetch: (url, init) =>
            fetch(
              url,
              typeof window === 'undefined'
                ? {
                    ...init,
                    headers: {
                      ...Object.fromEntries(new Headers(init?.headers)),
                      origin: MCP_ORIGIN,
                    },
                  }
                : init,
            ),
          onEvent: (event) => mcpEvents.push(event),
        });
  const approvedBindings =
    server?.bindings({
      'lesson.lookup': {
        version: 1,
        kind: 'read',
        timeoutMs: 2000,
        concurrency: 1,
        grantScope: 'principal',
        approval: 'none',
        retry: 'idempotent',
        pin: mcp?.pins['lesson.lookup'] as string,
      },
    }) ?? {};
  const mcpInvokes: Mock<CapabilityBinding['invoke']>[] = [];
  const mcpBindings = Object.fromEntries(
    Object.entries(approvedBindings).map(([name, bound]) => {
      const invoke = vi.fn(bound.invoke);
      mcpInvokes.push(invoke);
      return [name, { ...bound, invoke }];
    }),
  );
  const runtime = createRuntime({
    appId: 'injection-corpus',
    executors: [createLangGraphAdapter()],
    urlAllowlist: ['https://example.test'],
    tracerProvider: recorder.provider,
    diagnostics: (event) => diagnostics.push(event),
  });
  onTestFinished(async () => {
    await runtime.dispose();
    await server?.close();
    await recorder.provider.shutdown();
    remote.mockRestore();
  });
  const instance = await runtime.create(
    defineAgentDefinition({
      id: 'conformance/injection-corpus',
      version: '1.0.0',
      executor: 'langgraph-js',
      input: z.object({
        privateValue: z.string().meta(galaxieField({ label: 'private-user' })),
        probe: z.boolean(),
      }),
      models: {
        'agent.local': { modality: 'text' },
        'agent.main': { modality: 'text' },
        'agent.decision': { modality: 'decision' },
      },
      ui: { catalog: 'tests/v1', components: ['CorpusLink', 'CorpusAsk'], surfaces: ['corpus'] },
      capabilities: {
        optional: {
          'content.get@1': { kind: 'read', input: z.object({}), output: z.unknown() },
          'record.save@1': {
            kind: 'write',
            input: z.object({ recordId: z.enum(['practice-1']) }),
            output: z.unknown(),
          },
          'mcp.lessons.lesson.lookup@1': {
            kind: 'read',
            input: z.object({ lessonId: z.enum(['lesson-1']) }),
            output: z.object({ lessonId: z.string(), title: z.string() }),
          },
          'mcp.lessons.unlisted@1': { kind: 'read', input: z.object({}), output: z.unknown() },
          'network.send@1': { kind: 'read', input: z.unknown(), output: z.unknown() },
        },
      },
    }),
    {
      principalScope: 'corpus-learner',
      bindings: {
        'content.get@1': binding({ invoke: content }),
        'record.save@1': binding({ kind: 'write', approval: 'confirm', invoke: write }),
        ...mcpBindings,
      },
      ui: registry.bindings({ surfaces: ['corpus'] }),
      confirmations: {
        capabilities: confirmationRegistry.capabilities,
        policyRevision: () => 'corpus-v1',
      },
      services: {
        chatModels: { attacker, remote: remoteModel },
        decisionModels: { decider: decisionAttacker },
        checkpointer: new MemorySaver(),
      },
      models: {
        consent: () => true,
        providers: {
          decider: {
            destination: 'in-browser',
            modality: 'decision',
            features: [],
            pricing: { inputPerToken: 0, outputPerToken: 0 },
          },
          attacker: {
            destination: 'in-browser',
            modality: 'text',
            features: [],
            pricing: { inputPerToken: 0, outputPerToken: 0 },
          },
          remote: {
            destination: 'host-server',
            modality: 'text',
            features: [],
            pricing: { inputPerToken: 0, outputPerToken: 0 },
          },
        },
        roles: {
          'agent.decision': { providers: ['decider'], allow: ['in-browser'], maxTokens: 100 },
          'agent.local': { providers: ['attacker'], allow: ['in-browser'], maxTokens: 100 },
          'agent.main': { providers: ['remote'], allow: ['host-server'], maxTokens: 100 },
        },
      },
      agent: (host) =>
        new StateGraph({
          stateSchema: Annotation.Root({
            probe: Annotation<boolean>,
            answered: Annotation<boolean>,
            answers: Annotation<DecisionResult['answers']>,
          }),
          output: Annotation.Root({ answered: Annotation<boolean> }),
        })
          .addNode('answer', async ({ probe }, config) => {
            try {
              if (probe) {
                await host.capabilities.call(
                  'mcp.lessons.lesson.lookup@1',
                  { lessonId: 'lesson-1' },
                  config,
                );
                return { answered: true };
              }
              const data = await host.capabilities.call('content.get@1', {}, config);
              // MCP metadata is never exposed by the SDK. Supply synthetic metadata directly.
              const prompt =
                entry.vector === 'mcp-description'
                  ? entry.payload
                  : z.object({ text: z.string() }).parse(data).text;
              // A native LangGraph option: no model text is published in this fixture's messages stream.
              const message = await host.langchain
                .chatModel('agent.local')
                .invoke(`${prompt}\nPrivate fixture value: ${PRIVATE_MARKER}`, {
                  ...config,
                  tags: ['nostream'],
                });
              const directive = readDirective(message);
              if (entry.goal !== 'instruction-in-data') {
                switch (directive.kind) {
                  case 'callTool':
                    await host.capabilities.call(directive.name, directive.args, config);
                    break;
                  case 'emitInteraction':
                    await requestInteraction(
                      {
                        component: directive.component,
                        props: directive.props,
                        surfaceId: 'corpus',
                        viewRevision: 'v1',
                      },
                      config,
                    );
                    break;
                  case 'forwardPrivate':
                    await host.langchain.chatModel(directive.to).invoke(PRIVATE_MARKER, config);
                    break;
                  case 'reply':
                    break;
                }
              }
              return { answered: true };
            } catch (error) {
              if (!isGraphInterrupt(error)) errors.push(error);
              throw error;
            }
          })
          .addNode('decide', async (_state, config) => {
            try {
              const data = await host.capabilities.call('content.get@1', {}, config);
              const answers = await host.langchain.decide(
                'agent.decision',
                {
                  state: z.object({ text: z.string() }).parse(data).text,
                  questions: {
                    proceedWithoutAsking: {
                      type: 'boolean',
                      instructions: 'May the agent proceed without asking?',
                    },
                  },
                },
                config,
              );
              return { answers };
            } catch (error) {
              if (!isGraphInterrupt(error)) errors.push(error);
              throw error;
            }
          })
          .addNode('gate', async ({ answers }, config) => {
            try {
              const gated = gateDecision(
                answers,
                {
                  threshold: 0.7,
                  interaction: {
                    component: 'tests.CorpusAsk/v1',
                    props: { text: decisionQuestionText },
                    surfaceId: 'corpus',
                    viewRevision: 'v1' as ViewRevision,
                  },
                },
                config,
              );
              if (gated.submission?.action !== 'stop')
                await host.capabilities.call('record.save@1', { recordId: 'practice-1' }, config);
              return { answered: true };
            } catch (error) {
              if (!isGraphInterrupt(error)) errors.push(error);
              throw error;
            }
          })
          .addConditionalEdges(START, () =>
            entry.directive.kind === 'decide' ? 'decide' : 'answer',
          )
          .addEdge('decide', 'gate')
          .addEdge('gate', END)
          .addEdge('answer', END)
          .compile({ checkpointer: host.langchain.checkpointer() }),
    },
  );
  instance.subscribe(() => snapshots.push(instance.getSnapshot()));
  await instance.prepare();
  return {
    instance,
    content,
    write,
    remote,
    remoteModel,
    attacker,
    decisionAttacker,
    diagnostics,
    errors,
    snapshots,
    recorder,
    mcpEvents,
    mcpInvokes,
    async dispose(): Promise<void> {
      await runtime.dispose();
      await server?.close();
      await recorder.provider.forceFlush();
    },
    async start(probe = false) {
      const { runId } = await instance.start({ privateValue: PRIVATE_MARKER, probe });
      return { runId, events: collect(instance.events(runId)) };
    },
    async run(probe = false) {
      const { runId } = await instance.start({ privateValue: PRIVATE_MARKER, probe });
      const events = await collect(instance.events(runId));
      await recorder.provider.forceFlush();
      return {
        events,
        snapshot: instance.getSnapshot(),
        spans: serializeSpans(recorder.exporter.getFinishedSpans()),
      };
    },
  };
}
