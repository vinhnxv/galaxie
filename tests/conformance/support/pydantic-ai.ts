// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { createRuntime, defineAgentDefinition, GalaxieError, type RunEvent } from '@galaxie/core';
import { createMockLatch, MockChatModel, type MockScript } from '@galaxie/models/mock';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { BaseChatModel, type BindToolsInput } from '@langchain/core/language_models/chat_models';
import type { BaseMessage, ToolCall } from '@langchain/core/messages';
import type { ChatGenerationChunk, ChatResult } from '@langchain/core/outputs';
import { z } from 'zod';
import {
  createPyodideAdapter,
  type PyodideAdapterOptions,
  type PyodideAgent,
} from '../../../packages/adapter-pyodide/src/adapter.js';
import specs from '../cases-pydantic-ai/fixtures.json' with { type: 'json' };

export const pydanticCases = [
  'plain-text',
  'capability',
  'sequential-tools',
  'tool-output',
  'output-retry',
  'prompted-output',
  'capability-denial',
  'argument-block',
  'abort',
  'stream-text',
  'stream-tools',
  'stream-tool-output',
  'stream-output-retry',
  'stream-id-block',
  'stream-mid-block',
  'stream-final-mismatch',
  'stream-abort',
] as const;
interface Spec {
  readonly prompt: string;
  readonly replies: readonly { readonly text: string; readonly toolCalls?: readonly ToolCall[] }[];
}
export interface PydanticTranscript {
  readonly requests: unknown[];
  readonly responses: unknown[];
  readonly capabilities: unknown[];
  readonly interactions: unknown[];
  readonly streams?: unknown[];
  output: unknown;
  error: unknown;
}
function normalizeMessages(messages: BaseMessage[]): unknown[] {
  return messages.map((message) => {
    const role =
      message.type === 'human' ? 'user' : message.type === 'ai' ? 'assistant' : message.type;
    const result: Record<string, unknown> = { role, content: message.content ?? '' };
    if ('tool_calls' in message && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      result['tool_calls'] = message.tool_calls.map((call: ToolCall) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      }));
    }
    if ('tool_call_id' in message) result['tool_call_id'] = message.tool_call_id;
    return result;
  });
}
class RecordingModel extends BaseChatModel {
  readonly mock: MockChatModel;
  readonly transcript: PydanticTranscript;
  readonly script: MockScript;
  readonly tools: BindToolsInput[];
  readonly choice: unknown;
  readonly streamLatch: ReturnType<typeof createMockLatch> | undefined;
  constructor(
    script: MockScript,
    transcript: PydanticTranscript,
    tools: BindToolsInput[] = [],
    choice?: unknown,
    streamLatch?: ReturnType<typeof createMockLatch>,
  ) {
    super({});
    this.script = script;
    this.transcript = transcript;
    this.tools = tools;
    this.choice = choice;
    this.streamLatch = streamLatch;
    this.mock = tools.length
      ? new MockChatModel(script).bindTools(tools)
      : new MockChatModel(script);
  }
  override _llmType(): string {
    return 'conformance-recording';
  }
  override bindTools(
    tools: BindToolsInput[],
    kwargs?: Partial<this['ParsedCallOptions']>,
  ): RecordingModel {
    return new RecordingModel(
      this.script,
      this.transcript,
      tools,
      kwargs?.tool_choice,
      this.streamLatch,
    );
  }
  override async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
  ): Promise<ChatResult> {
    this.transcript.requests.push({
      messages: normalizeMessages(messages),
      tools: this.tools,
      ...(this.tools.length ? { toolChoice: this.choice } : {}),
    });
    const result = await this.mock._generate(messages, options);
    const message = result.generations[0]?.message;
    if (!message) throw new Error('The scripted reply is missing.');
    this.transcript.responses.push({
      content: message.content,
      toolCalls: 'tool_calls' in message ? message.tool_calls : [],
    });
    return result;
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    // Record the provider's complete scripted reply, including replies blocked during delivery.
    await this._generate(messages, options);
    let first = true;
    for await (const chunk of this.mock._streamResponseChunks(messages, options, runManager)) {
      yield chunk;
      if (first) await this.streamLatch?.wait(options.signal);
      first = false;
    }
  }
}

export async function executePydanticCase(
  options: PyodideAdapterOptions,
  agent: PyodideAgent,
  name: string,
): Promise<PydanticTranscript> {
  if (!(pydanticCases as readonly string[]).includes(name))
    throw new Error('The conformance case is unknown.');
  const spec = (specs as Record<string, Spec>)[name];
  if (!spec) throw new Error('The conformance script is missing.');
  const transcript: PydanticTranscript = {
    requests: [],
    responses: [],
    capabilities: [],
    interactions: [],
    ...(name.startsWith('stream-') ? { streams: [] } : {}),
    output: null,
    error: null,
  };
  const latch = createMockLatch();
  const script: MockScript = {
    [spec.prompt]: spec.replies.map((reply, index) => ({
      ...reply,
      id: `reply-${index}`,
      usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
      ...(name === 'abort' ? { wait: latch } : {}),
    })),
  };
  const model = new RecordingModel(
    script,
    transcript,
    [],
    undefined,
    name === 'stream-abort' ? latch : undefined,
  );
  const runtime = createRuntime({
    appId: 'pydantic-conformance',
    executors: [createPyodideAdapter({ ...options, framework: 'pydantic-ai' })],
    budgets: { steps: 25, toolCalls: 10, tokens: 2000 },
    outputSafety: ({ text }) => (/BLOCKED_(ARGUMENT|ID|TEXT)/.test(text) ? 'block' : 'allow'),
  });
  try {
    const instance = await runtime.create(
      defineAgentDefinition({
        id: 'conformance/pydantic-ai',
        version: '1.0.0',
        executor: 'pydantic-ai-python',
        input: z.object({ prompt: z.string() }),
        models: { answer: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' } },
        capabilities: {
          required: {
            'math.double@1': {
              kind: 'read',
              input: z.object({ value: z.number().int() }),
              output: z.object({ value: z.number().int() }),
            },
          },
        },
      }),
      {
        principalScope: 'fixture',
        agent,
        services: { chatModels: { mock: model } },
        bindings: {
          'math.double@1': {
            kind: 'read',
            destination: 'in-browser',
            timeoutMs: 1000,
            concurrency: 1,
            grantScope: 'instance',
            approval: 'none',
            retry: 'none',
            async invoke(input: { value: number }) {
              transcript.capabilities.push({ name: 'math.double@1', input });
              if (name === 'capability-denial')
                throw new GalaxieError('denied', 'Policy denied the request.');
              return { value: input.value * 2 };
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
    const { runId } = await instance.start({ prompt: spec.prompt });
    const events = (async (): Promise<RunEvent[]> => {
      const recorded: RunEvent[] = [];
      for await (const event of instance.events(runId)) {
        recorded.push(event);
        if (name === 'stream-abort' && event.type === 'stream' && event.mode === 'messages')
          await instance.cancel(runId);
      }
      return recorded;
    })();
    if (name === 'abort') {
      await latch.entered;
      await instance.cancel(runId);
    }
    for (const event of await events) {
      if (event.type === 'output') transcript.output = event.output;
      else if (event.type === 'error') transcript.error = event.error;
      else if (event.type === 'cancelled')
        transcript.error = { code: 'cancelled', message: 'The run was cancelled.' };
      else if (event.type === 'interaction') transcript.interactions.push(event);
      else if (event.type === 'stream') {
        if (event.executor !== 'pydantic-ai-python' || event.path.length !== 0)
          throw new Error('The stream has an unexpected executor or path.');
        transcript.streams?.push({ mode: event.mode, data: event.data });
      }
    }
    return JSON.parse(JSON.stringify(transcript)) as PydanticTranscript;
  } finally {
    latch.release();
    await runtime.dispose();
  }
}
