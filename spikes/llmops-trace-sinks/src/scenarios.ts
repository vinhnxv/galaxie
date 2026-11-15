// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { type LangGraphHost, requestInteraction } from '@galaxie-ai/adapter-langgraph';
import { type AgentInstance, defineAgentDefinition, galaxieField } from '@galaxie-ai/core';
import { HumanMessage } from '@langchain/core/messages';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph/web';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import { z } from 'zod';
import {
  FixtureModelError,
  ScriptedChatModel,
} from '../../../tests/conformance/support/scripted-chat-model.js';
import { createHost, type Host, type HostOptions } from './host.js';
import type { RunTrace } from './run-trace.js';

export const scenarios = ['linear', 'tool-call', 'interrupt-resume', 'model-failure'] as const;
export type Scenario = (typeof scenarios)[number];
export const prompt = 'Synthetic Node host prompt';
export const reply = 'Synthetic Node host reply';
export const errorText = 'Synthetic model failure message must never enter telemetry';

export interface ScenarioResult {
  name: Scenario;
  text: boolean;
  spans: ReadableSpan[];
  traceIds: string[];
  runId: string;
  runTrace: RunTrace[];
  credentialCalls: number;
  exportErrors: Host['exportErrors'];
}

export async function runScenario(
  name: Scenario,
  options: HostOptions & { onHost?: (host: Host) => void },
): Promise<ScenarioResult> {
  const host = scenarioHost(name, options);
  options.onHost?.(host);
  try {
    const instance = await scenarioInstance(host, name);
    await instance.prepare();
    const { runId } = await instance.start({ value: 'synthetic public input' });
    for await (const event of instance.events(runId)) if (event.type === 'interaction') break;
    if (name === 'interrupt-resume') {
      const pending = instance.getSnapshot().run?.pending;
      if (pending === undefined) throw new Error('Scenario did not pause');
      const receipt = await instance.dispatch({
        ...pending,
        instanceId: instance.instanceId,
        runId,
        action: 'submit',
        payload: false,
      });
      if (receipt.status !== 'accepted') throw new Error('Scenario resume was not accepted');
      for await (const _event of instance.events(runId)) {
      }
    }
    if (instance.getSnapshot().run?.status !== (name === 'model-failure' ? 'failed' : 'succeeded'))
      throw new Error('Unexpected scenario settlement');
    await host.runtime.dispose();
    await host.flush();
    const spans = host.oracle.getFinishedSpans();
    return {
      name,
      text: options.text,
      spans,
      traceIds: [...new Set(spans.map((span) => span.spanContext().traceId))],
      runId,
      runTrace: host.runTrace.entries(),
      credentialCalls: host.credentialCalls(),
      exportErrors: host.exportErrors,
    };
  } finally {
    await host.runtime.dispose();
    await host.shutdown();
  }
}

function scenarioHost(name: Scenario, options: HostOptions): Host {
  const model = new ScriptedChatModel({
    [prompt]:
      name === 'model-failure'
        ? { error: new FixtureModelError(errorText) }
        : {
            id: 'synthetic-reply',
            text: reply,
            usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
          },
  });
  return createHost(model, {
    ...options,
    key: `${name}-${options.text ? 'text' : 'plain'}`,
  });
}

async function scenarioInstance(
  host: Host,
  name: Scenario,
): Promise<AgentInstance<{ value: string }, unknown>> {
  return host.runtime.create(
    defineAgentDefinition({
      id: `spike/${name}`,
      version: '1.0.0',
      executor: 'langgraph-js',
      input: z.object({ value: z.string().meta(galaxieField({ label: 'public' })) }),
      models: { assistant: { modality: 'text' } },
      capabilities: {
        optional: {
          'lookup@1': {
            input: z.object({ query: z.string() }),
            output: z.string().meta(galaxieField({ label: 'public' })),
            kind: 'read',
          },
        },
      },
    }),
    {
      principalScope: 'synthetic-host',
      models: host.routing,
      services: { chatModels: { assistant: host.modelFactory } },
      bindings: {
        'lookup@1': {
          destination: 'host-server',
          kind: 'read',
          timeoutMs: 5000,
          concurrency: 1,
          grantScope: 'principal',
          approval: 'none',
          retry: 'idempotent',
          invoke: async () => 'synthetic capability result',
        },
      },
      agent: (context: LangGraphHost) => {
        const state = Annotation.Root({ value: Annotation<string> });
        const respond = async (
          _state: unknown,
          config: Parameters<typeof requestInteraction>[1],
        ): Promise<Record<string, never>> => {
          await context.langchain.chatModel('assistant').invoke([new HumanMessage(prompt)], config);
          return {};
        };
        const graph = new StateGraph(state).addNode('respond', respond).addEdge(START, 'respond');
        if (name === 'tool-call')
          return graph
            .addNode('lookup', async (_state, config) => {
              await context.capabilities.call(
                'lookup@1',
                { query: 'synthetic lookup argument' },
                config,
              );
              return {};
            })
            .addEdge('respond', 'lookup')
            .addEdge('lookup', END)
            .compile();
        if (name === 'interrupt-resume')
          return graph
            .addNode('ask', (_state, config) => {
              requestInteraction(
                {
                  surfaceId: 'main',
                  viewRevision: 'r1',
                  component: 'spike.Question/v1',
                  props: { question: 'Continue?' },
                },
                config,
              );
              return {};
            })
            .addNode('after', respond)
            .addEdge('respond', 'ask')
            .addEdge('ask', 'after')
            .addEdge('after', END)
            .compile({ checkpointer: context.langchain.checkpointer() });
        return graph.addEdge('respond', END).compile();
      },
    },
  );
}

export interface SessionsResult {
  text: boolean;
  sessionCopy: boolean;
  spans: ReadableSpan[];
  runTrace: RunTrace[];
  credentialCalls: number;
}

export async function runSessions(options: HostOptions): Promise<SessionsResult> {
  const host = scenarioHost('linear', options);
  try {
    for (let session = 0; session < 2; session++) {
      const instance = await scenarioInstance(host, 'linear');
      await instance.prepare();
      for (let run = 0; run < 3; run++) {
        const { runId } = await instance.start({ value: 'synthetic public input' });
        for await (const _event of instance.events(runId)) {
        }
        if (instance.getSnapshot().run?.status !== 'succeeded')
          throw new Error('Sequential session run did not succeed');
      }
    }
    await host.runtime.dispose();
    await host.flush();
    return {
      text: options.text,
      sessionCopy: options.sessionCopy ?? false,
      spans: host.oracle.getFinishedSpans(),
      runTrace: host.runTrace.entries(),
      credentialCalls: host.credentialCalls(),
    };
  } finally {
    await host.runtime.dispose();
    await host.shutdown();
  }
}
