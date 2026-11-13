// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  createRuntime,
  defineAgentDefinition,
  type PendingInteraction,
  type SessionId,
} from '@galaxie-ai/core';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { z } from 'zod';
import {
  createPyodideAdapter,
  type PyodideAdapterOptions,
  type PyodideAgent,
} from '../../../packages/adapter-pyodide/src/adapter.js';
import cases from '../cases-dspy/schema-output-golden-cases.json' with { type: 'json' };
import type { DspyTranscript } from './dspy.js';
import type { GoldenStore } from './dspy-golden.js';

export const dspySchemaSpecs: Readonly<Record<string, { golden: string; reply: string }>> = cases;
export const dspySchemaCases: readonly string[] = Object.keys(cases);

export interface SchemaResult {
  readonly transcript: DspyTranscript;
  readonly sessionId: string;
  readonly pending?: PendingInteraction;
  readonly restored?: PendingInteraction;
  readonly replayed: number[];
}

export async function executeDspySchema(
  options: PyodideAdapterOptions,
  agent: PyodideAgent,
  name: string,
  settings: { feature?: boolean; store?: GoldenStore; sessionId?: string } = {},
): Promise<SchemaResult> {
  const spec = dspySchemaSpecs[name];
  if (!spec) throw new Error('The DSPy schema case is unknown.');
  const transcript: DspyTranscript = {
    requests: [],
    responses: [],
    capabilities: [],
    interactions: [],
    output: null,
    error: null,
  };
  const replayed: number[] = [];
  class Model extends BaseChatModel {
    override _llmType(): string {
      return 'dspy-schema';
    }
    override async _generate(
      input: BaseMessage[],
      call: this['ParsedCallOptions'],
    ): Promise<ChatResult> {
      const jsonSchema: unknown = Reflect.get(call, 'jsonSchema');
      transcript.requests.push({
        messages: input.map((message) => ({
          role:
            message.type === 'human' ? 'user' : message.type === 'ai' ? 'assistant' : message.type,
          content: message.content,
        })),
        ...(call.stop === undefined ? {} : { stop: call.stop }),
        ...(jsonSchema === undefined ? {} : { jsonSchema }),
      });
      transcript.responses.push({ content: spec?.reply, toolCalls: [] });
      return {
        generations: [{ text: spec?.reply ?? '', message: new AIMessage(spec?.reply ?? '') }],
      };
    }
  }
  const runtime = createRuntime({
    appId: 'dspy-schema',
    executors: [createPyodideAdapter({ ...options, framework: 'dspy' })],
    budgets: { steps: 25, toolCalls: 10, tokens: 2000 },
    outputSafety: () => 'allow',
  });
  try {
    const instance = await runtime.create(
      defineAgentDefinition({
        id: 'conformance/dspy-schema',
        version: '1',
        executor: 'dspy-python',
        input: z.object({ question: z.string() }),
        models: { answer: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' } },
      }),
      {
        principalScope: 'fixture',
        agent,
        ...(settings.store ? { recovery: settings.store.recovery } : {}),
        ...(settings.sessionId ? { sessionId: settings.sessionId as SessionId } : {}),
        services: {
          chatModels: { mock: new Model({}) },
          ...(settings.store ? { checkpoints: settings.store.checkpoints } : {}),
        },
        ui: {
          surfaces: ['main'],
          components: { 'test.Review/v1': { actions: { continue: { payload: z.string() } } } },
        },
        bindings: {},
        models: {
          providers: {
            mock: {
              destination: 'in-browser',
              modality: 'text',
              languages: ['en'],
              features: settings.feature === false ? [] : ['structured-output'],
              pricing: { inputPerToken: 0, outputPerToken: 0 },
            },
          },
          roles: { answer: { providers: ['mock'], allow: ['in-browser'], maxTokens: 100 } },
        },
      },
    );
    await instance.prepare();
    const run = settings.sessionId
      ? await instance.restore()
      : await instance.start({ question: 'Which answer?' });
    if (!run) throw new Error('The DSPy schema run is missing.');
    const restored = settings.sessionId ? instance.getSnapshot().run?.pending : undefined;
    if (restored) {
      const receipt = await instance.dispatch({
        instanceId: instance.instanceId,
        runId: run.runId,
        ...restored,
        action: 'continue',
        payload: 'continue',
      });
      if (receipt.status !== 'accepted') throw new Error('The schema submission was rejected.');
    }
    let pending: PendingInteraction | undefined;
    for await (const event of instance.events(run.runId)) {
      if (event.type === 'output') transcript.output = event.output;
      else if (event.type === 'error') transcript.error = event.error;
      else if (event.type === 'cancelled') throw new Error('The DSPy schema run was cancelled.');
      else if (
        event.type === 'interaction' &&
        event.interaction.interactionId !== restored?.interactionId
      ) {
        pending = event.interaction;
        const { interactionId: _, ...request } = pending;
        transcript.interactions.push(request);
        break;
      } else if (event.type === 'stream' && event.mode === 'updates') {
        const data = event.data as { kind?: string; count?: number };
        if (data.kind === 'replayed' && data.count !== undefined) replayed.push(data.count);
      }
    }
    return {
      transcript,
      sessionId: instance.sessionId,
      replayed,
      ...(pending ? { pending } : {}),
      ...(restored ? { restored } : {}),
    };
  } finally {
    await runtime.dispose();
  }
}
