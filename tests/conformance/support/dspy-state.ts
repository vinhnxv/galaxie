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
import fixtures from '../cases-dspy/state-fixtures.json' with { type: 'json' };
import type { DspyTranscript } from './dspy.js';

export const dspyStateCases: readonly string[] = Object.keys(fixtures);
export interface StateSpec {
  readonly state: string;
  readonly question: string;
  readonly replies: readonly { readonly text: string }[];
}
export const stateSpecs: Readonly<Record<string, StateSpec>> = fixtures;

class ScriptedModel extends BaseChatModel {
  private index = 0;
  private readonly spec: StateSpec;
  private readonly transcript: DspyTranscript;
  constructor(spec: StateSpec, transcript: DspyTranscript) {
    super({});
    this.spec = spec;
    this.transcript = transcript;
  }
  override _llmType(): string {
    return 'dspy-state-conformance';
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

/** A custom spec also drives the synthetic size cases through the same public lifecycle. */
export async function executeDspyStateCase(
  options: PyodideAdapterOptions,
  agent: PyodideAgent,
  name: string,
  customSpec?: StateSpec,
): Promise<DspyTranscript> {
  const spec = customSpec ?? stateSpecs[name];
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
    appId: 'dspy-state-conformance',
    executors: [createPyodideAdapter({ ...options, framework: 'dspy' })],
    budgets: { steps: 25, toolCalls: 10, tokens: 2000 },
    outputSafety: () => 'allow',
  });
  try {
    const instance = await runtime.create(
      defineAgentDefinition({
        id: 'conformance/dspy-state',
        version: '1.0.0',
        executor: 'dspy-python',
        input: z.object({ question: z.string() }),
        models: { answer: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' } },
        capabilities: {
          required: {
            'docs.lookup@1': {
              kind: 'read',
              input: z.object({ query: z.string() }),
              output: z.string(),
            },
          },
        },
      }),
      {
        principalScope: 'fixture',
        agent,
        services: { chatModels: { mock: model } },
        bindings: {
          'docs.lookup@1': {
            kind: 'read',
            destination: 'in-browser',
            timeoutMs: 1000,
            concurrency: 1,
            grantScope: 'instance',
            approval: 'none',
            retry: 'none',
            async invoke(input: { query: string }) {
              transcript.capabilities.push({ name: 'docs.lookup@1', input });
              return 'Paris';
            },
          },
        },
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
