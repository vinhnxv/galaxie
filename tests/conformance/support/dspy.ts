// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { createRuntime, defineAgentDefinition, GalaxieError, toErrorInfo } from '@galaxie/core';
import { BaseChatModel, type BindToolsInput } from '@langchain/core/language_models/chat_models';
import {
  AIMessage,
  type BaseMessage,
  type StandardMessageStructure,
} from '@langchain/core/messages';
import type { ToolCall } from '@langchain/core/messages/tool';
import type { ChatResult } from '@langchain/core/outputs';
import { z } from 'zod';
import {
  createPyodideAdapter,
  type PyodideAdapterOptions,
  type PyodideAgent,
} from '../../../packages/adapter-pyodide/src/adapter.js';
import { createMockLatch } from '../../../packages/models/src/mock.js';
import fixtures from '../cases-dspy/fixtures.json' with { type: 'json' };

export const dspyCases: readonly string[] = Object.keys(fixtures);
interface Spec {
  readonly replies: readonly { readonly text: string; readonly toolCalls?: readonly ToolCall[] }[];
}
export interface DspyTranscript {
  readonly requests: unknown[];
  readonly responses: unknown[];
  readonly capabilities: unknown[];
  readonly interactions: unknown[];
  output: unknown;
  error: unknown;
}

function messages(input: BaseMessage[]): unknown[] {
  return input.map((message) => {
    const value: Record<string, unknown> = {
      role: message.type === 'human' ? 'user' : message.type === 'ai' ? 'assistant' : message.type,
      content: message.content,
    };
    if ('tool_calls' in message && Array.isArray(message.tool_calls) && message.tool_calls.length)
      value['tool_calls'] = (message.tool_calls as ToolCall[]).map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.args },
      }));
    if ('tool_call_id' in message) value['tool_call_id'] = message.tool_call_id;
    return value;
  });
}

class ScriptedModel extends BaseChatModel {
  readonly caseName: string;
  readonly transcript: DspyTranscript;
  readonly latch: ReturnType<typeof createMockLatch>;
  readonly state: { index: number };
  readonly tools: BindToolsInput[];
  readonly choice: unknown;
  constructor(
    name: string,
    transcript: DspyTranscript,
    latch: ReturnType<typeof createMockLatch>,
    state = { index: 0 },
    tools: BindToolsInput[] = [],
    choice?: unknown,
  ) {
    super({});
    this.caseName = name;
    this.transcript = transcript;
    this.latch = latch;
    this.state = state;
    this.tools = tools;
    this.choice = choice;
  }
  override _llmType(): string {
    return 'dspy-conformance';
  }
  override bindTools(
    tools: BindToolsInput[],
    options?: Partial<this['ParsedCallOptions']>,
  ): ScriptedModel {
    return new ScriptedModel(
      this.caseName,
      this.transcript,
      this.latch,
      this.state,
      tools,
      options?.tool_choice,
    );
  }
  override async _generate(
    input: BaseMessage[],
    options: this['ParsedCallOptions'],
  ): Promise<ChatResult> {
    this.transcript.requests.push({
      messages: messages(input),
      ...(this.tools.length
        ? { tools: this.tools, ...(this.choice === undefined ? {} : { tool_choice: this.choice }) }
        : {}),
      ...(options.stop === undefined ? {} : { stop: options.stop }),
    });
    if (this.caseName === 'abort') await this.latch.wait(options.signal);
    const spec = (fixtures as Record<string, Spec>)[this.caseName];
    const reply = spec?.replies[this.state.index++];
    if (!reply) throw new Error('The conformance reply is missing.');
    this.transcript.responses.push({ content: reply.text, toolCalls: reply.toolCalls ?? [] });
    return {
      generations: [
        {
          text: reply.text,
          message: new AIMessage<StandardMessageStructure>({
            content: reply.text,
            tool_calls: [...(reply.toolCalls ?? [])],
            usage_metadata: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
          }),
        },
      ],
    };
  }
}

export async function executeDspyCase(
  options: PyodideAdapterOptions,
  agent: PyodideAgent,
  name: string,
): Promise<DspyTranscript> {
  if (!dspyCases.includes(name)) throw new Error('The conformance case is unknown.');
  const transcript: DspyTranscript = {
    requests: [],
    responses: [],
    capabilities: [],
    interactions: [],
    output: null,
    error: null,
  };
  const latch = createMockLatch();
  const model = new ScriptedModel(name, transcript, latch);
  const runtime = createRuntime({
    appId: 'dspy-conformance',
    executors: [createPyodideAdapter({ ...options, framework: 'dspy' })],
    budgets: { steps: 25, toolCalls: 10, tokens: 2000 },
    outputSafety: ({ text }) => (text.includes('BLOCKED_') ? 'block' : 'allow'),
  });
  const kind = name === 'outcome-unknown' ? 'write' : 'read';
  try {
    const instance = await runtime.create(
      defineAgentDefinition({
        id: 'conformance/dspy',
        version: '1.0.0',
        executor: 'dspy-python',
        input: z.object({ question: z.string() }),
        models: { answer: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' } },
        capabilities: {
          required: {
            'docs.lookup@1': { kind, input: z.object({ query: z.string() }), output: z.string() },
          },
        },
      }),
      {
        principalScope: 'fixture',
        agent,
        services: { chatModels: { mock: model } },
        bindings: {
          'docs.lookup@1': {
            kind,
            destination: 'in-browser',
            timeoutMs: 1000,
            concurrency: 1,
            grantScope: 'instance',
            approval: 'none',
            retry: 'none',
            async invoke(input: { query: string }) {
              transcript.capabilities.push({ name: 'docs.lookup@1', input });
              if (name === 'capability-denial')
                throw new GalaxieError('denied', 'Policy denied the request.');
              if (name === 'outcome-unknown')
                throw new GalaxieError('outcome_unknown', 'The write outcome is unknown.');
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
              features: ['tool-calling'],
              pricing: { inputPerToken: 0, outputPerToken: 0 },
            },
          },
          roles: { answer: { providers: ['mock'], allow: ['in-browser'], maxTokens: 100 } },
        },
      },
    );
    await instance.prepare();
    const { runId } = await instance.start({ question: 'What is the capital of France?' });
    const events = (async (): Promise<void> => {
      for await (const event of instance.events(runId)) {
        if (event.type === 'output') transcript.output = event.output;
        if (event.type === 'error') transcript.error = event.error;
        if (event.type === 'cancelled')
          transcript.error = { code: 'cancelled', message: 'The run was cancelled.' };
        if (event.type === 'stream' || event.type === 'interaction')
          throw new Error('D1 emitted an unsupported event.');
      }
    })();
    if (name === 'abort') {
      await latch.entered;
      await instance.cancel(runId);
    }
    await events;
  } catch (error) {
    transcript.error = toErrorInfo(error instanceof GalaxieError ? error.code : 'executor_error');
  } finally {
    latch.release();
    await runtime.dispose();
  }
  return JSON.parse(JSON.stringify(transcript)) as DspyTranscript;
}
