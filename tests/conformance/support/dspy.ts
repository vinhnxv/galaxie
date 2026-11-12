// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createRuntime, defineAgentDefinition, GalaxieError, toErrorInfo } from '@galaxie-ai/core';
import { BaseChatModel, type BindToolsInput } from '@langchain/core/language_models/chat_models';
import {
  AIMessage,
  AIMessageChunk,
  type BaseMessage,
  type StandardMessageStructure,
} from '@langchain/core/messages';
import type { ToolCall } from '@langchain/core/messages/tool';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import { z } from 'zod';
import {
  createPyodideAdapter,
  type PyodideAdapterOptions,
  type PyodideAgent,
} from '../../../packages/adapter-pyodide/src/adapter.js';
import { createMockLatch } from '../../../packages/models/src/mock.js';
import fixtures from '../cases-dspy/fixtures.json' with { type: 'json' };
import { autoApprove, confirmationsFor } from './auto-confirm.js';

export const dspyBranchReloadCases = ['fanout-reload'] as const;
export const dspyCases: readonly string[] = Object.keys(fixtures);
interface Spec {
  readonly unordered?: boolean;
  readonly fragmented?: boolean;
  readonly resumes?: readonly { readonly action: string; readonly payload: unknown }[];
  readonly runs?: number;
  readonly steps?: number;
  readonly replies: readonly {
    readonly text: string;
    readonly question?: string;
    readonly toolCalls?: readonly ToolCall[];
    readonly chunks?: readonly string[];
  }[];
}
export interface DspyTranscript {
  readonly requests: unknown[];
  readonly responses: unknown[];
  readonly capabilities: unknown[];
  readonly interactions: unknown[];
  output: unknown;
  error: unknown;
  events?: { mode: string; data: Record<string, unknown> }[];
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
    const question = String(input.at(-1)?.content)
      .split('[[ ## question ## ]]\n')[1]
      ?.split('\n\n')[0]
      ?.trim();
    const reply = spec?.unordered
      ? spec.replies.find((item) => item.question === question)
      : spec?.replies[this.state.index++];
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
  override async *_streamResponseChunks(
    input: BaseMessage[],
    options: this['ParsedCallOptions'],
  ): AsyncGenerator<ChatGenerationChunk> {
    const spec = (fixtures as Record<string, Spec>)[this.caseName];
    const reply = spec?.replies[this.state.index];
    await this._generate(input, options);
    if (!reply) throw new Error('The conformance reply is missing.');
    const chunks = spec?.fragmented ? [...reply.text] : (reply.chunks ?? []);
    for (const [index, text] of chunks.entries()) {
      yield new ChatGenerationChunk({ text, message: new AIMessageChunk({ content: text }) });
      if (this.caseName === 'stream-abort' && index === 1) await this.latch.wait(options.signal);
    }
    yield new ChatGenerationChunk({
      text: '',
      message: new AIMessageChunk<StandardMessageStructure>({
        content: '',
        ...(reply.toolCalls?.length
          ? {
              tool_call_chunks: reply.toolCalls.map((call, index) => ({
                index,
                ...(call.id === undefined ? {} : { id: call.id }),
                name: call.name,
                args: JSON.stringify(call.args),
                type: 'tool_call_chunk' as const,
              })),
            }
          : {}),
        usage_metadata: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
      }),
    });
  }
}

export async function executeDspyCase(
  options: PyodideAdapterOptions,
  agent: PyodideAgent,
  name: string,
  steps?: number,
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
  const streaming = name.startsWith('stream-');
  const pauses = name.includes('pause-');
  const spec = (fixtures as Record<string, Spec>)[name];
  if (streaming || pauses) transcript.events = [];
  let sawText: (() => void) | undefined;
  const streamed = new Promise<void>((resolve) => {
    sawText = resolve;
  });
  const latch = createMockLatch();
  const model = new ScriptedModel(name, transcript, latch);
  const runtime = createRuntime({
    appId: 'dspy-conformance',
    executors: [createPyodideAdapter({ ...options, framework: 'dspy' })],
    budgets: { steps: steps ?? spec?.steps ?? 25, toolCalls: 10, tokens: 2000 },
    outputSafety: ({ text }) => (text.includes('BLOCKED_') ? 'block' : 'allow'),
  });
  const kind = name.endsWith('outcome-unknown') || pauses || spec?.unordered ? 'write' : 'read';
  // A model-chosen write runs only behind a host confirmation, approved here as it appears.
  const approval = kind === 'write' ? 'confirm' : 'none';
  let stopApproving = (): void => {};
  try {
    const instance = await runtime.create(
      defineAgentDefinition({
        id: 'conformance/dspy',
        version: '1.0.0',
        executor: 'dspy-python',
        input: z.object({
          question: pauses
            ? z.string().meta({ 'x-galaxie': { label: 'private-user' } })
            : z.string(),
        }),
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
        ...(kind === 'write'
          ? { confirmations: confirmationsFor(['docs.lookup@1'], 'dspy-conformance-v1') }
          : {}),
        ui: {
          surfaces: ['main'],
          components: {
            'test.Review/v1': { actions: { continue: { payload: z.string() } } },
          },
        },
        bindings: {
          'docs.lookup@1': {
            kind,
            destination: 'in-browser',
            timeoutMs: 1000,
            concurrency: spec?.unordered ? 3 : 1,
            grantScope: 'instance',
            approval,
            retry: 'none',
            async invoke(input: { query: string }) {
              transcript.capabilities.push({ name: 'docs.lookup@1', input });
              if (name === 'capability-denial')
                throw new GalaxieError('denied', 'Policy denied the request.');
              if (name.endsWith('outcome-unknown'))
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
              features: ['tool-calling', 'streaming'],
              pricing: { inputPerToken: 0, outputPerToken: 0 },
            },
          },
          roles: { answer: { providers: ['mock'], allow: ['in-browser'], maxTokens: 100 } },
        },
      },
    );
    await instance.prepare();
    if (kind === 'write') stopApproving = autoApprove(instance);
    const ids = new Set<string>();
    let answerIndex = 0;
    for (let round = 0; round < (spec?.runs ?? 1); round++) {
      const { runId } = await instance.start({ question: 'What is the capital of France?' });
      const events = (async (): Promise<void> => {
        for await (const event of instance.events(runId)) {
          if (event.type === 'output') transcript.output = event.output;
          if (event.type === 'error') transcript.error = event.error;
          if (event.type === 'cancelled')
            transcript.error = { code: 'cancelled', message: 'The run was cancelled.' };
          if (event.type === 'interaction') {
            const pending = instance.getSnapshot().run?.pending;
            if (!pauses || !pending || ids.has(pending.interactionId))
              throw new Error('DSPy emitted a missing or repeated interaction.');
            ids.add(pending.interactionId);
            const { interactionId: _, ...request } = pending;
            transcript.interactions.push(request);
            const beforeStale = [transcript.requests.length, transcript.capabilities.length];
            const stale = await instance.dispatch({
              instanceId: instance.instanceId,
              runId,
              ...pending,
              interactionId: 'wrong' as typeof pending.interactionId,
              action: 'continue',
              payload: 'stale answer',
            });
            if (
              stale.status !== 'rejected' ||
              stale.error.code !== 'stale' ||
              beforeStale[0] !== transcript.requests.length ||
              beforeStale[1] !== transcript.capabilities.length
            )
              throw new Error('The stale answer dispatched work.');
            const answer = spec?.resumes?.[answerIndex++];
            if (!answer) throw new Error('The interaction answer is missing.');
            const submission = { instanceId: instance.instanceId, runId, ...pending, ...answer };
            const [first, duplicate] = await Promise.all([
              instance.dispatch(submission),
              instance.dispatch(submission),
            ]);
            if (
              first?.status !== 'accepted' ||
              duplicate?.status !== 'rejected' ||
              duplicate.error.code !== 'duplicate'
            )
              throw new Error('The submission inbox did not accept exactly one answer.');
          }
          if (event.type === 'stream') {
            if ((!streaming && !pauses) || !transcript.events || event.path.length)
              throw new Error('DSPy emitted an unexpected stream.');
            const data = event.data as Record<string, unknown>;
            if (event.mode === 'messages') {
              if (
                Object.keys(data).sort().join(',') !== 'field,text' ||
                typeof data['field'] !== 'string' ||
                typeof data['text'] !== 'string' ||
                data['text'].includes('BLOCKED_') ||
                !['answer', 'next_thought'].includes(data['field'])
              )
                throw new Error('DSPy emitted an invalid field projection.');
              sawText?.();
            } else if (
              event.mode !== 'updates' ||
              !(
                (data['kind'] === 'model' &&
                  Number.isInteger(data['index']) &&
                  Object.keys(data).sort().join(',') === 'index,kind') ||
                (data['kind'] === 'tool' &&
                  Number.isInteger(data['index']) &&
                  typeof data['name'] === 'string' &&
                  Object.keys(data).sort().join(',') === 'index,kind,name') ||
                (pauses &&
                  ['pause', 'unrecoverable'].includes(String(data['kind'])) &&
                  Object.keys(data).join(',') === 'kind') ||
                (pauses &&
                  data['kind'] === 'replayed' &&
                  Number.isInteger(data['count']) &&
                  Object.keys(data).sort().join(',') === 'count,kind')
              )
            )
              throw new Error('DSPy emitted an invalid progress projection.');
            if (pauses && !instance.getSnapshot().run?.labels.includes('private-user'))
              throw new Error('A DSPy replay lost its private label.');
            const previous = transcript.events.at(-1);
            if (
              event.mode === 'messages' &&
              previous?.mode === 'messages' &&
              previous.data['field'] === data['field']
            ) {
              previous.data['text'] = String(previous.data['text']) + data['text'];
            } else transcript.events.push({ mode: event.mode, data: { ...data } });
          }
        }
      })();
      if (name === 'abort' || name === 'stream-abort') {
        await latch.entered;
        if (name === 'stream-abort') await streamed;
        await instance.cancel(runId);
      }
      await events;
    }
  } catch (error) {
    transcript.error = toErrorInfo(error instanceof GalaxieError ? error.code : 'executor_error');
  } finally {
    stopApproving();
    latch.release();
    await runtime.dispose();
  }
  if (spec?.unordered) {
    const key = (value: unknown, field: 'request' | 'response' | 'capability'): string => {
      const item = value as {
        messages?: { content: string }[];
        content?: string;
        input?: { query: string };
      };
      return field === 'request'
        ? (item.messages?.at(-1)?.content ?? '')
        : field === 'response'
          ? (item.content ?? '')
          : (item.input?.query ?? '');
    };
    const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
    transcript.requests.sort((a, b) => compare(key(a, 'request'), key(b, 'request')));
    transcript.responses.sort((a, b) => compare(key(a, 'response'), key(b, 'response')));
    transcript.capabilities.sort((a, b) => compare(key(a, 'capability'), key(b, 'capability')));
  }
  return JSON.parse(JSON.stringify(transcript)) as DspyTranscript;
}
