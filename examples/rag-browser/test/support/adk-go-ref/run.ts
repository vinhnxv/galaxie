// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

// Runs one ADK Go conformance case through the real adapter. The Node and Chromium lanes share it, so
// both observe the same program, the same scripted model and the same bridge traffic.

import { createRuntime, defineAgentDefinition, GalaxieError, type RunEvent } from '@galaxie/core';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, AIMessageChunk, type BaseMessage } from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import { z } from 'zod';
import {
  createGoAdapter,
  type GoWasmReference,
  type GoWorkerPort,
} from '../../../../../packages/adapter-go/src/index.js';

export interface ScriptedReply {
  readonly content?: string;
  /** Text pieces a streaming run receives one by one; they join to `content`. */
  readonly chunks?: readonly string[];
  readonly toolCalls?: ReadonlyArray<{
    readonly id: string;
    readonly function: { readonly name: string; readonly arguments: string };
  }>;
  readonly error?: string;
}
export interface ScriptedStream {
  readonly mode: string;
  readonly data: unknown;
}
export interface ScriptedAnswer {
  readonly action: string;
  readonly payload?: unknown;
}
export interface Script {
  readonly entry: string;
  readonly prompt: string;
  /** Replies, in order, to the interactions the run raises. */
  readonly answers?: readonly ScriptedAnswer[];
  /** Asks the adapter for stream events; the expected ones are listed in `streams`. */
  readonly stream?: boolean;
  readonly streams?: readonly ScriptedStream[];
  readonly replies: ReadonlyArray<ScriptedReply>;
  readonly capabilities: Readonly<Record<string, { result?: unknown; error?: string }>>;
}
export interface Observed {
  /** The interaction requests the run raised, without their interaction IDs. */
  readonly pauses: unknown[];
  readonly requests: unknown[];
  readonly responses: unknown[];
  readonly capabilities: unknown[];
  readonly output: string;
  readonly error: { code: string } | null;
  readonly streams: ScriptedStream[];
  readonly coldStartMs: number | undefined;
}

/** Answers with the next scripted reply whatever the messages say; the goldens compare requests. */
export class ScriptedChatModel extends BaseChatModel {
  served = 0;
  readonly #replies: ReadonlyArray<ScriptedReply>;
  constructor(replies: ReadonlyArray<ScriptedReply>) {
    super({});
    this.#replies = replies;
  }
  override _llmType(): string {
    return 'galaxie-adk-go-scripted';
  }
  override bindTools(): ScriptedChatModel {
    return this;
  }
  override async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    const reply = this.#replies[this.served++];
    if (reply === undefined) throw new GalaxieError('unavailable', 'No scripted reply is left.');
    if (reply.error !== undefined)
      throw new GalaxieError(reply.error as 'unavailable', 'A scripted model failure.');
    const message = new AIMessage({
      content: reply.content ?? '',
      tool_calls: (reply.toolCalls ?? []).map((call) => ({
        id: call.id,
        name: call.function.name,
        args: JSON.parse(call.function.arguments) as Record<string, unknown>,
      })),
    });
    return { generations: [{ text: reply.content ?? '', message }] };
  }
  /** Streams the reply's chunks; a tool call arrives as one raw fragment on the last chunk. */
  override async *_streamResponseChunks(
    _messages: BaseMessage[],
  ): AsyncGenerator<ChatGenerationChunk> {
    const reply = this.#replies[this.served++];
    if (reply === undefined) throw new GalaxieError('unavailable', 'No scripted reply is left.');
    if (reply.error !== undefined)
      throw new GalaxieError(reply.error as 'unavailable', 'A scripted model failure.');
    const pieces = reply.chunks ?? [reply.content ?? ''];
    for (const [position, text] of pieces.entries()) {
      const last = position === pieces.length - 1;
      yield new ChatGenerationChunk({
        text,
        message: new AIMessageChunk({
          content: text,
          ...(last && reply.toolCalls
            ? {
                tool_call_chunks: reply.toolCalls.map((call, index) => ({
                  type: 'tool_call_chunk' as const,
                  id: call.id,
                  name: call.function.name,
                  args: call.function.arguments,
                  index,
                })),
              }
            : {}),
        }),
      });
    }
  }
}

const definition = defineAgentDefinition({
  id: 'conformance/adk-go',
  version: '1.0.0',
  executor: 'adk-go',
  input: z.object({ prompt: z.string() }),
  capabilities: {
    required: {
      'math.double@1': {
        kind: 'read',
        input: z.object({ value: z.number() }),
        output: z.object({ value: z.number() }),
      },
    },
  },
  models: { answer: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' } },
});

/** What the native golden records: the wire transcript, with pauses only when a case has any. */
export function comparable(observed: Observed): Record<string, unknown> {
  return {
    requests: observed.requests,
    responses: observed.responses,
    capabilities: observed.capabilities,
    ...(observed.pauses.length > 0 ? { pauses: observed.pauses } : {}),
    output: observed.output,
    error: observed.error,
  };
}

export async function runCase(
  name: string,
  script: Script,
  wasm: GoWasmReference,
  createWorker: () => GoWorkerPort,
): Promise<Observed> {
  const frames: Array<{ op: string; payload: unknown }> = [];
  let coldStartMs: number | undefined;
  const model = new ScriptedChatModel(script.replies);
  const runtime = createRuntime({
    appId: `adk-go-${name}`,
    executors: [
      createGoAdapter({
        createWorker: () => {
          const port = createWorker();
          port.addEventListener('message', (event) => {
            if (typeof event.data !== 'string') return;
            const message = JSON.parse(event.data) as {
              kind: string;
              op?: string;
              payload?: string;
            };
            if (message.kind === 'call' && message.op && message.payload)
              frames.push({ op: message.op, payload: JSON.parse(message.payload) });
          });
          return port;
        },
        onBoot: (event) => {
          if (event.phase === 'ready') coldStartMs = event.coldStartMs;
        },
      }),
    ],
    outputSafety: () => 'allow',
  });
  try {
    const instance = await runtime.create(definition, {
      principalScope: 'fixture',
      agent: { wasm, entry: script.entry, ...(script.stream ? { stream: true } : {}) },
      services: { chatModels: { mock: model } },
      models: {
        providers: {
          mock: {
            destination: 'in-browser',
            modality: 'text',
            features: ['tool-calling'],
            languages: ['en'],
            pricing: { inputPerToken: 0, outputPerToken: 0 },
          },
        },
        roles: { answer: { providers: ['mock'], allow: ['in-browser'], maxTokens: 100 } },
      },
      bindings: {
        'math.double@1': {
          kind: 'read',
          destination: 'in-browser',
          timeoutMs: 5000,
          concurrency: 1,
          grantScope: 'instance',
          approval: 'none',
          retry: 'none',
          invoke: async () => {
            const outcome = script.capabilities['math.double@1'];
            if (outcome?.error)
              throw new GalaxieError(outcome.error as 'denied', 'Scripted failure.');
            return outcome?.result as { value: number };
          },
        },
      },
    });
    await instance.prepare();
    const { runId } = await instance.start({ prompt: script.prompt });
    const events: RunEvent[] = [];
    const streams: ScriptedStream[] = [];
    const pauses: unknown[] = [];
    let answered = 0;
    for await (const event of instance.events(runId)) {
      if (event.type === 'stream') streams.push({ mode: event.mode, data: event.data });
      if (event.type === 'interaction') {
        const { interactionId: _id, ...request } = event.interaction;
        pauses.push(request);
        const answer = script.answers?.[answered++];
        if (answer === undefined) throw new Error('The run paused with no answer left.');
        const receipt = await instance.dispatch({
          instanceId: instance.instanceId,
          runId,
          ...event.interaction,
          action: answer.action,
          payload: answer.payload,
        });
        if (receipt.status !== 'accepted') throw new Error('The answer was not accepted.');
      }
      events.push(event);
    }
    const end = events.at(-1);
    return {
      pauses,
      requests: frames.filter((frame) => frame.op === 'model').map((frame) => frame.payload),
      // The goldens record the aggregated replies Go receives, never the page-side chunks.
      responses: script.replies
        .slice(0, model.served)
        .map(({ chunks: _chunks, ...reply }) => reply),
      capabilities: frames
        .filter((frame) => frame.op === 'capability')
        .map((frame) => frame.payload),
      output: end?.type === 'output' ? String(end.output) : '',
      error: end?.type === 'error' ? { code: end.error.code } : null,
      streams,
      coldStartMs,
    };
  } finally {
    await runtime.dispose();
  }
}
