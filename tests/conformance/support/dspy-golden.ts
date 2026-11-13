// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  createRuntime,
  defineAgentDefinition,
  type PendingInteraction,
  type RecoveryStore,
  type SessionId,
} from '@galaxie-ai/core';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  AIMessage,
  type BaseMessage,
  type StandardMessageStructure,
} from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { z } from 'zod';
import {
  createPyodideAdapter,
  type PyodideAdapterOptions,
  type PyodideAgent,
} from '../../../packages/adapter-pyodide/src/adapter.js';
import providerLm from '../cases-dspy/provider-lm-golden-cases.json' with { type: 'json' };
import retrieval from '../cases-dspy/retrieval-golden-cases.json' with { type: 'json' };
import runtime from '../cases-dspy/runtime-golden-cases.json' with { type: 'json' };
import type { DspyTranscript } from './dspy.js';

interface GoldenSpec {
  readonly golden: string;
  readonly input?: { readonly question: string; readonly mode?: string };
  readonly role?: string;
  readonly replies?: readonly { readonly text: string }[];
  readonly resumes?: readonly { readonly action: string; readonly payload: string }[];
  readonly capability?: (typeof retrieval)['rag-docs-search']['capability'];
}
export const dspyGoldenSpecs: Readonly<Record<string, GoldenSpec>> = {
  ...runtime,
  ...retrieval,
  ...providerLm,
};
export const dspyGoldenCases: readonly string[] = Object.keys(dspyGoldenSpecs);

export function dspyGoldenFamily(name: string): 'runtime' | 'retrieval' | 'provider-lm' {
  if (Object.hasOwn(runtime, name)) return 'runtime';
  if (Object.hasOwn(retrieval, name)) return 'retrieval';
  if (Object.hasOwn(providerLm, name)) return 'provider-lm';
  throw new Error('The DSPy golden case is unknown.');
}
export interface GoldenStore {
  readonly checkpoints: { request(value: unknown): Promise<unknown> };
  readonly recovery: RecoveryStore;
}
export interface GoldenStep {
  readonly sessionId?: string;
}
export interface GoldenResult {
  readonly transcript: DspyTranscript;
  readonly sideEvidence: Record<string, unknown>[];
  readonly sessionId: string;
  readonly pending?: PendingInteraction;
  readonly restored?: PendingInteraction;
}

/** One live run, or one durable Worker lifetime when a store is supplied. */
export async function executeDspyGolden(
  options: PyodideAdapterOptions,
  agent: PyodideAgent,
  name: string,
  store?: GoldenStore,
  step: GoldenStep = {},
): Promise<GoldenResult> {
  const spec = dspyGoldenSpecs[name];
  if (!spec) throw new Error('The DSPy golden case is unknown.');
  const transcript: DspyTranscript = {
    requests: [],
    responses: [],
    capabilities: [],
    interactions: [],
    output: null,
    error: null,
    ...(spec.resumes ? { events: [] } : {}),
  };
  const sideEvidence: Record<string, unknown>[] = [];
  let replyIndex = step.sessionId ? 1 : 0;
  class Model extends BaseChatModel {
    override _llmType(): string {
      return 'dspy-golden';
    }
    override async _generate(
      input: BaseMessage[],
      options: this['ParsedCallOptions'],
    ): Promise<ChatResult> {
      transcript.requests.push({
        messages: input.map((message) => ({
          role:
            message.type === 'human' ? 'user' : message.type === 'ai' ? 'assistant' : message.type,
          content: message.content,
        })),
        ...(options.stop === undefined ? {} : { stop: options.stop }),
      });
      const reply = spec?.replies?.[replyIndex++];
      if (!reply) throw new Error('The DSPy golden reply is missing.');
      transcript.responses.push({ content: reply.text, toolCalls: [] });
      return {
        generations: [
          {
            text: reply.text,
            message: new AIMessage<StandardMessageStructure>({
              content: reply.text,
              usage_metadata: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
            }),
          },
        ],
      };
    }
  }
  const capability = spec.capability;
  const role = spec.role ?? 'answer';
  const runtime = createRuntime({
    appId: 'dspy-golden',
    executors: [createPyodideAdapter({ ...options, framework: 'dspy' })],
    budgets: { steps: 25, toolCalls: 10, tokens: 2000 },
    outputSafety: () => 'allow',
  });
  try {
    const instance = await runtime.create(
      defineAgentDefinition({
        id: 'conformance/dspy-golden',
        version: '1',
        executor: 'dspy-python',
        input: z.object({ question: z.string(), mode: z.string().optional() }),
        models: { [role]: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' } },
        capabilities: {
          required: capability
            ? {
                'docs.search@1': {
                  kind: 'read',
                  input: z.fromJSONSchema(
                    capability.inputSchema as Parameters<typeof z.fromJSONSchema>[0],
                  ),
                  output: z.fromJSONSchema(
                    capability.outputSchema as Parameters<typeof z.fromJSONSchema>[0],
                  ),
                },
              }
            : {},
        },
      }),
      {
        principalScope: 'fixture',
        agent,
        ...(store ? { recovery: store.recovery } : {}),
        ...(step.sessionId ? { sessionId: step.sessionId as SessionId } : {}),
        services: {
          chatModels: { mock: new Model({}) },
          ...(store ? { checkpoints: store.checkpoints } : {}),
        },
        ui: {
          surfaces: ['main'],
          components: { 'test.Review/v1': { actions: { continue: { payload: z.string() } } } },
        },
        bindings: capability
          ? {
              'docs.search@1': {
                kind: 'read',
                destination: 'in-browser',
                timeoutMs: 1000,
                concurrency: 1,
                grantScope: 'instance',
                approval: 'none',
                retry: 'none',
                async invoke(input: unknown) {
                  transcript.capabilities.push({ name: capability.name, input });
                  return capability.result;
                },
              },
            }
          : {},
        models: {
          providers: {
            mock: {
              destination: 'in-browser',
              modality: 'text',
              languages: ['en'],
              features: [],
              pricing: { inputPerToken: 0, outputPerToken: 0 },
            },
          },
          roles: { [role]: { providers: ['mock'], allow: ['in-browser'], maxTokens: 100 } },
        },
      },
    );
    await instance.prepare();
    const run = step.sessionId
      ? await instance.restore()
      : await instance.start(spec.input ?? { question: 'RESTORED_INPUT_SECRET' });
    if (!run) throw new Error('The DSPy golden run is missing.');
    const restored = step.sessionId ? instance.getSnapshot().run?.pending : undefined;
    const answer = spec.resumes?.[0];
    const dispatch = async (pending: PendingInteraction): Promise<void> => {
      if (!answer) throw new Error('The DSPy golden submission is missing.');
      const receipt = await instance.dispatch({
        instanceId: instance.instanceId,
        runId: run.runId,
        ...pending,
        ...answer,
      });
      if (receipt.status !== 'accepted')
        throw new Error('The DSPy golden submission was rejected.');
    };
    if (restored) await dispatch(restored);
    let pending: PendingInteraction | undefined;
    for await (const event of instance.events(run.runId)) {
      if (event.type === 'output') transcript.output = event.output;
      else if (event.type === 'error') transcript.error = event.error;
      else if (event.type === 'cancelled') throw new Error('The DSPy golden run was cancelled.');
      else if (event.type === 'interaction') {
        if (event.interaction.interactionId === restored?.interactionId) continue;
        const { interactionId: _, ...request } = event.interaction;
        transcript.interactions.push(request);
        if (store) {
          pending = event.interaction;
          break;
        }
        await dispatch(event.interaction);
      } else if (event.type === 'stream') {
        const data = event.data as Record<string, unknown>;
        if (event.mode !== 'updates' || event.path.length)
          throw new Error('Unexpected DSPy golden stream.');
        if (['spike-tasks', 'provider-egress'].includes(String(data['kind'])))
          sideEvidence.push(data);
        else if (transcript.events && ['pause', 'replayed'].includes(String(data['kind'])))
          transcript.events.push({ mode: event.mode, data });
        else throw new Error('Unexpected DSPy golden progress.');
      }
    }
    return JSON.parse(
      JSON.stringify({
        transcript,
        sideEvidence,
        sessionId: instance.sessionId,
        ...(pending ? { pending } : {}),
        ...(restored ? { restored } : {}),
      }),
    ) as GoldenResult;
  } finally {
    await runtime.dispose();
  }
}
