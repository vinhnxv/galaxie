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
import specs from '../cases-adk-python/fixtures.json' with { type: 'json' };

export const adkPythonCases = [
  'plain-text',
  'capability',
  'sequential-tools',
  'output-schema',
  'capability-denial',
  'argument-block',
  'step-budget',
  'abort',
  'stream-text',
  'stream-tools',
  'stream-mid-block',
  'stream-abort',
  'confirm-approve',
  'confirm-deny',
  'confirm-two',
  'long-running',
  'confirm-stale',
  'confirm-incomplete',
  'confirm-double-submit',
  'confirm-consecutive',
  'stream-confirm-approve',
] as const;
/** The Chromium lane repeats these; the Node lane runs all of them. */
export const adkPythonBrowserCases = [
  'plain-text',
  'capability',
  'abort',
  'stream-text',
  'stream-abort',
  'confirm-approve',
] as const;
const stepLimit = 2;
interface Spec {
  readonly prompt: string;
  readonly replies: readonly { readonly text: string; readonly toolCalls?: readonly ToolCall[] }[];
  readonly answers?: readonly { readonly action: string; readonly payload: unknown }[];
}
export interface AdkPythonTranscript {
  readonly requests: unknown[];
  readonly responses: unknown[];
  readonly capabilities: unknown[];
  readonly interactions: unknown[];
  readonly streams?: unknown[];
  dispatches?: string[];
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
export class RecordingModel extends BaseChatModel {
  readonly mock: MockChatModel;
  readonly transcript: AdkPythonTranscript;
  readonly script: MockScript;
  readonly tools: BindToolsInput[];
  readonly choice: unknown;
  readonly streamLatch: ReturnType<typeof createMockLatch> | undefined;
  constructor(
    script: MockScript,
    transcript: AdkPythonTranscript,
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
    const jsonSchema = (options as { jsonSchema?: unknown }).jsonSchema;
    this.transcript.requests.push({
      messages: normalizeMessages(messages),
      tools: this.tools,
      ...(this.tools.length ? { toolChoice: this.choice } : {}),
      ...(jsonSchema === undefined ? {} : { jsonSchema }),
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

/** Provider call IDs differ per lane (ADK generates one, galaxie assigns one): number them by appearance. */
export function renumber(requests: unknown[]): void {
  const known = new Map<string, string>();
  const number = (id: string): string => {
    const existing = known.get(id);
    if (existing !== undefined) return existing;
    const value = `call-${known.size + 1}`;
    known.set(id, value);
    return value;
  };
  for (const request of requests as { messages: Record<string, unknown>[] }[])
    for (const message of request.messages) {
      for (const call of (message['tool_calls'] as { id: string }[] | undefined) ?? [])
        call.id = number(call.id);
      if (typeof message['tool_call_id'] === 'string')
        message['tool_call_id'] = number(message['tool_call_id']);
    }
}

export async function executeAdkPythonCase(
  options: PyodideAdapterOptions,
  agent: PyodideAgent,
  name: string,
): Promise<AdkPythonTranscript> {
  if (!(adkPythonCases as readonly string[]).includes(name))
    throw new Error('The conformance case is unknown.');
  const spec = (specs as Record<string, Spec>)[name];
  if (!spec) throw new Error('The conformance script is missing.');
  const transcript: AdkPythonTranscript = {
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
    appId: 'adk-python-conformance',
    executors: [createPyodideAdapter({ ...options, framework: 'adk' })],
    budgets: { steps: name === 'step-budget' ? stepLimit : 25, toolCalls: 10, tokens: 2000 },
    outputSafety: ({ text }) => (/BLOCKED_(ARGUMENT|TEXT)/.test(text) ? 'block' : 'allow'),
  });
  try {
    const instance = await runtime.create(
      defineAgentDefinition({
        id: 'conformance/adk-python',
        version: '1.0.0',
        executor: 'adk-python',
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
        ui: {
          surfaces: ['main'],
          components: {
            'tests.Approval/v1': {
              actions: Object.fromEntries(
                ['approve', 'deny', 'submit'].map((action) => [action, { payload: z.unknown() }]),
              ),
            },
          },
        },
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
              features: ['tool-calling', 'structured-output', 'streaming'],
              pricing: { inputPerToken: 0, outputPerToken: 0 },
            },
          },
          roles: { answer: { providers: ['mock'], allow: ['in-browser'], maxTokens: 100 } },
        },
      },
    );
    await instance.prepare();
    const { runId } = await instance.start({ prompt: spec.prompt });
    const ids = new Set<string>();
    let answerIndex = 0;
    const events = (async (): Promise<RunEvent[]> => {
      const recorded: RunEvent[] = [];
      for await (const event of instance.events(runId)) {
        recorded.push(event);
        if (name === 'stream-abort' && event.type === 'stream' && event.mode === 'messages')
          await instance.cancel(runId);
        if (event.type === 'interaction') {
          const pending = instance.getSnapshot().run?.pending;
          if (!pending || ids.has(pending.interactionId))
            throw new Error('The pending interaction is missing or reused.');
          ids.add(pending.interactionId);
          const answer = spec.answers?.[answerIndex++];
          if (!answer) throw new Error('The interaction answer is missing.');
          const submission = {
            instanceId: instance.instanceId,
            runId,
            ...pending,
            ...answer,
            ...(name === 'confirm-stale'
              ? { interactionId: 'wrong' as typeof pending.interactionId }
              : {}),
          };
          const receipts = await Promise.all([
            instance.dispatch(submission),
            ...(name === 'confirm-double-submit' ? [instance.dispatch(submission)] : []),
          ]);
          if (name === 'confirm-double-submit')
            transcript.dispatches = receipts.map((receipt) =>
              receipt.status === 'accepted' ? 'accepted' : `rejected:${receipt.error.code}`,
            );
          if (name === 'confirm-stale') {
            const receipt = receipts[0];
            if (receipt?.status !== 'rejected') throw new Error('The stale answer was accepted.');
            transcript.error = receipt.error;
            break;
          }
          if (receipts[0]?.status !== 'accepted')
            throw new Error('The interaction answer was rejected.');
        }
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
      else if (event.type === 'interaction') {
        transcript.interactions.push({
          ...event.interaction,
          interactionId: `pause-${transcript.interactions.length}`,
        });
      } else if (event.type === 'stream') {
        if (event.executor !== 'adk-python' || event.path.length !== 0)
          throw new Error('The stream has an unexpected executor or path.');
        transcript.streams?.push({ mode: event.mode, data: event.data });
      }
    }
    const actual = JSON.parse(JSON.stringify(transcript)) as AdkPythonTranscript;
    renumber(actual.requests);
    return actual;
  } finally {
    latch.release();
    await runtime.dispose();
  }
}
