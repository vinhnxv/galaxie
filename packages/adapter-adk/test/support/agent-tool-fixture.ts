// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  type AgentInstance,
  type BudgetLimits,
  type CapabilityBinding,
  type CapabilityName,
  createRuntime,
  type DataPolicy,
  defineAgentDefinition,
  type ExecutorAdapter,
  galaxieField,
  type ModelRouting,
  type RunEvent,
  type SessionId,
} from '@galaxie-ai/core';
import { type Event, LlmAgent } from '@google/adk';
import { AIMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { MemoryByteCheckpoints } from '../../../../tests/conformance/support/memory-byte-checkpoints.js';
import { binding, collect } from '../../../core/test/fake-executor.js';
import {
  type AdkAgent,
  agentTool,
  type CapabilityToolSpec,
  createAdkAdapter,
} from '../../src/index.js';
import { FakeChatModel, type Reply } from './fixtures.js';

export const spec: CapabilityToolSpec = { description: 'Read.', parameters: z.object({}) };
export const text = (content: string): AIMessage => new AIMessage({ content });
export const calls = (...requests: string[]): AIMessage =>
  new AIMessage({
    content: '',
    tool_calls: requests.map((request, index) => ({
      id: `call_${index}`,
      name: 'inner',
      args: { request },
    })),
  });
export const read = (): AIMessage =>
  new AIMessage({ content: '', tool_calls: [{ id: 'read', name: 'read_1', args: {} }] });
export const hasTool: Reply = (seen) =>
  text(String(seen.messages.some((message) => message.type === 'tool')));

export interface Options {
  readonly outer?: Reply;
  readonly inner?: Reply;
  readonly kind?: 'read' | 'write' | 'missing';
  readonly approval?: 'none' | 'confirm';
  readonly confirmations?: boolean;
  readonly grantScope?: 'instance' | 'run';
  readonly grants?: readonly CapabilityName[];
  readonly store?: MemoryByteCheckpoints;
  readonly sessionId?: SessionId;
  readonly agent?: AdkAgent;
  readonly budgets?: Partial<BudgetLimits>;
  readonly invoke?: CapabilityBinding['invoke'];
  readonly privateOutput?: boolean;
  readonly dataPolicy?: DataPolicy;
  readonly block?: string;
}

export interface AgentToolFixture {
  readonly runtime: ReturnType<typeof createRuntime>;
  readonly instance: AgentInstance<unknown, unknown>;
  readonly run: (prompt?: string) => Promise<RunEvent[]>;
  readonly outer: FakeChatModel;
  readonly inner: FakeChatModel;
  readonly leases: string[];
  readonly store: MemoryByteCheckpoints;
  readonly operations: unknown[];
  readonly record: () => { events: Event[] } | undefined;
  readonly invocations: () => number;
}

export async function fixture(options: Options = {}): Promise<AgentToolFixture> {
  const outer = new FakeChatModel(
    options.outer ?? ((_seen, index) => (index === 0 ? calls('request') : text('outer done'))),
  );
  const inner = new FakeChatModel(options.inner ?? (() => text('inner done')));
  const leases: string[] = [];
  const base = createAdkAdapter();
  const adapter: ExecutorAdapter<
    AdkAgent,
    {
      chatModels: Record<string, FakeChatModel>;
      checkpoints: { request(value: unknown): Promise<unknown> };
    }
  > = {
    ...base,
    async prepare(...args) {
      const prepared = await base.prepare(...args);
      return {
        ...prepared,
        run(request) {
          // Continue the adapter conversation with a fresh real-runtime broker port.
          // Core's adopted-session API is restore-only; continuation is an executor gate.
          return prepared.run({
            ...request,
            ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
            models: {
              begin(role, settings) {
                leases.push(role);
                return request.models.begin(role, settings);
              },
            },
          });
        },
      };
    },
  };
  const store = options.store ?? new MemoryByteCheckpoints();
  const operations: unknown[] = [];
  let invoked = 0;
  const runtime = createRuntime({
    appId: 'admission-tests',
    executors: [adapter],
    budgets: { steps: 12, toolCalls: 12, tokens: 5000, ...options.budgets },
    ...(options.dataPolicy === undefined ? {} : { dataPolicy: options.dataPolicy }),
    outputSafety: ({ text: value }) =>
      options.block !== undefined && value.includes(options.block) ? 'block' : 'allow',
  });
  const routing: ModelRouting = {
    providers: Object.fromEntries(
      ['outer', 'inner'].map((role) => [
        role,
        {
          destination: 'in-browser',
          modality: 'text',
          languages: ['en'],
          features: ['tool-calling'],
          pricing: { inputPerToken: 0, outputPerToken: 0 },
        },
      ]),
    ),
    roles: Object.fromEntries(
      ['outer', 'inner'].map((role) => [
        role,
        { providers: [role], allow: ['in-browser'], maxTokens: 100 },
      ]),
    ),
  };
  const definition = defineAgentDefinition({
    id: 'tests/admission',
    version: '1.0.0',
    executor: 'adk-js',
    input: z.object({ prompt: z.string() }),
    models: {
      outer: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' },
      inner: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' },
    },
    capabilities: {
      optional: {
        'read@1': {
          kind: options.kind === 'write' ? 'write' : 'read',
          input: spec.parameters,
          output: options.privateOutput
            ? z.unknown().meta(galaxieField({ label: 'private-user' }))
            : z.unknown(),
        },
      },
    },
  });
  const instance = await runtime.create(definition, {
    principalScope: 'user',
    services: {
      chatModels: { outer, inner },
      checkpoints: {
        async request(value) {
          operations.push(structuredClone(value));
          return store.request(value);
        },
      },
    },
    models: routing,
    ...(options.confirmations
      ? { confirmations: { capabilities: ['read@1'], policyRevision: () => 'v1' } }
      : {}),
    bindings:
      options.kind === 'missing'
        ? {}
        : {
            'read@1': binding({
              kind: options.kind ?? 'read',
              grantScope: options.grantScope ?? 'instance',
              approval: options.approval ?? 'none',
              async invoke(input, context) {
                invoked++;
                return options.invoke ? options.invoke(input, context) : 'read result';
              },
            }),
          },
    agent:
      options.agent ??
      ((host) =>
        new LlmAgent({
          name: 'outer',
          model: host.adk.llm('outer'),
          tools: [
            agentTool(
              host,
              new LlmAgent({
                name: 'inner',
                model: host.adk.llm('inner'),
                tools: [host.adk.capabilityTool('read@1', spec)],
              }),
            ),
          ],
        })),
  });
  await instance.prepare();
  const run = async (prompt = 'public request') => {
    const { runId } = await instance.start({ prompt }, { grants: options.grants ?? [] });
    return collect(instance.events(runId));
  };
  const record = () => {
    const row = [...store.rows.values()].at(-1);
    return row === undefined
      ? undefined
      : (JSON.parse(new TextDecoder().decode(row.checkpoint.bytes)) as { events: Event[] });
  };
  return {
    runtime,
    instance,
    run,
    outer,
    inner,
    leases,
    store,
    operations,
    record,
    invocations: (): number => invoked,
  };
}
