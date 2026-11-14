// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createRuntime, defineAgentDefinition, GalaxieError, toErrorInfo } from '@galaxie-ai/core';
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
import fixtures from '../cases-dspy/optimizer-state-fixtures.json' with { type: 'json' };
import type { DspyTranscript } from './dspy.js';

export const dspyOptimizerStateCases: readonly string[] = Object.keys(fixtures);
export interface OptimizerStateSpec {
  readonly state: string;
  readonly question: string;
  readonly replies: readonly { readonly text: string }[];
}
export const optimizerStateSpecs: Readonly<Record<string, OptimizerStateSpec>> = fixtures;

class ScriptedModel extends BaseChatModel {
  private index = 0;
  private readonly spec: OptimizerStateSpec;
  private readonly transcript: DspyTranscript;
  constructor(spec: OptimizerStateSpec, transcript: DspyTranscript) {
    super({});
    this.spec = spec;
    this.transcript = transcript;
  }
  override _llmType(): string {
    return 'dspy-optimizer-state-conformance';
  }
  override async _generate(input: BaseMessage[]): Promise<ChatResult> {
    this.transcript.requests.push({
      messages: input.map((message) => ({
        role:
          message.type === 'human' ? 'user' : message.type === 'ai' ? 'assistant' : message.type,
        content: message.content,
      })),
    });
    const reply = this.spec.replies[this.index++];
    if (!reply) throw new Error('The state conformance reply is missing.');
    this.transcript.responses.push({ content: reply.text, toolCalls: [] });
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

export async function executeDspyOptimizerStateCase(
  options: PyodideAdapterOptions,
  agent: PyodideAgent,
  name: string,
): Promise<DspyTranscript> {
  const spec = optimizerStateSpecs[name];
  if (!spec) throw new Error('The state conformance case is unknown.');
  const transcript: DspyTranscript = {
    requests: [],
    responses: [],
    capabilities: [],
    interactions: [],
    output: null,
    error: null,
  };
  const model = new ScriptedModel(spec, transcript);
  const runtime = createRuntime({
    appId: 'dspy-optimizer-state-conformance',
    executors: [createPyodideAdapter({ ...options, framework: 'dspy' })],
    budgets: { steps: 25, toolCalls: 10, tokens: 2000 },
    outputSafety: () => 'allow',
  });
  try {
    const instance = await runtime.create(
      defineAgentDefinition({
        id: 'conformance/dspy-optimizer-state',
        version: '1.0.0',
        executor: 'dspy-python',
        input: z.object({ question: z.string() }),
        models: { answer: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' } },
      }),
      {
        principalScope: 'fixture',
        agent,
        services: { chatModels: { mock: model } },

        models: {
          providers: {
            mock: {
              destination: 'in-browser',
              modality: 'text',
              languages: ['en'],
              features: ['tool-calling', 'streaming'],
              pricing: { inputPerToken: 0, outputPerToken: 0 },
            },
          },
          roles: { answer: { providers: ['mock'], allow: ['in-browser'], maxTokens: 100 } },
        },
      },
    );
    await instance.prepare();
    const { runId } = await instance.start({ question: spec.question });
    for await (const event of instance.events(runId)) {
      if (event.type === 'output') transcript.output = event.output;
      if (event.type === 'error') transcript.error = event.error;
    }
  } catch (error) {
    transcript.error = toErrorInfo(error instanceof GalaxieError ? error.code : 'executor_error');
  } finally {
    await runtime.dispose();
  }
  return JSON.parse(JSON.stringify(transcript)) as DspyTranscript;
}
