// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

// Runs one ADK Go conformance case through the real adapter. The Node and Chromium lanes share it, so
// both observe the same program, the same scripted model and the same bridge traffic.

import {
  type AgentInstance,
  createRuntime,
  defineAgentDefinition,
  GalaxieError,
  type RecoveryStore,
  type RunEvent,
  type RunId,
  type SessionId,
} from '@galaxie-ai/core';
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
  /** Compares the wire lists as sets: parallel branches reach the page in any order. */
  readonly unordered?: boolean;
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
  readonly unordered: boolean;
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
    optional: {
      'math.triple@1': {
        kind: 'read',
        input: z.object({ value: z.number() }),
        output: z.object({ value: z.number() }),
      },
    },
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

/** Serializes a value with sorted keys, so two equal JSON values give one text. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null)
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/** Orders a wire list by its canonical text when the case runs branches concurrently. */
function ordered(list: unknown[], unordered: boolean): unknown[] {
  if (!unordered) return list;
  const keys = new Map(list.map((item) => [item, canonical(item)] as const));
  return [...list].sort((left, right) => {
    const a = keys.get(left) as string;
    const b = keys.get(right) as string;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/** What the native golden records: the wire transcript, with pauses only when a case has any. */
export function comparable(observed: Observed): Record<string, unknown> {
  return {
    requests: ordered(observed.requests, observed.unordered),
    responses: ordered(observed.responses, observed.unordered),
    capabilities: ordered(observed.capabilities, observed.unordered),
    ...(observed.pauses.length > 0 ? { pauses: observed.pauses } : {}),
    output: observed.output,
    error: observed.error,
  };
}

/** The storage a durable run reopens after every pause, as a page does after a reload. */
export interface DurableStore {
  readonly checkpoints: { request(value: unknown): Promise<unknown> };
  readonly recovery: RecoveryStore;
  close(): void;
}
export interface Durability {
  open(): Promise<DurableStore>;
}

/**
 * Runs the case. With `durable`, every pause ends the runtime and its Worker, reopens the storage
 * and restores the session in a new runtime with a new Worker before the answer is dispatched, so
 * the conversation travels only through the stored record.
 */
export async function runCase(
  name: string,
  script: Script,
  wasm: GoWasmReference,
  createWorker: () => GoWorkerPort,
  durable?: Durability,
): Promise<Observed> {
  const frames: Array<{ op: string; payload: unknown }> = [];
  let coldStartMs: number | undefined;
  const model = new ScriptedChatModel(script.replies);
  interface Life {
    readonly runtime: ReturnType<typeof createRuntime>;
    readonly instance: AgentInstance<unknown, unknown>;
    readonly store: DurableStore | undefined;
  }
  const open = async (sessionId?: SessionId): Promise<Life> => {
    const store = durable === undefined ? undefined : await durable.open();
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
    const instance = await runtime.create(definition, {
      principalScope: 'fixture',
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(store === undefined ? {} : { recovery: store.recovery }),
      agent: { wasm, entry: script.entry, ...(script.stream ? { stream: true } : {}) },
      services: {
        chatModels: { mock: model },
        ...(store === undefined ? {} : { checkpoints: store.checkpoints }),
      },
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
        ...(script.capabilities['math.triple@1']
          ? {
              'math.triple@1': {
                kind: 'read' as const,
                destination: 'in-browser' as const,
                timeoutMs: 5000,
                concurrency: 1,
                grantScope: 'instance' as const,
                approval: 'none' as const,
                retry: 'none' as const,
                invoke: async () =>
                  script.capabilities['math.triple@1']?.result as { value: number },
              },
            }
          : {}),
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
    return { runtime, instance: instance as AgentInstance<unknown, unknown>, store };
  };
  let life = await open();
  try {
    let runId: RunId = (await life.instance.start({ prompt: script.prompt })).runId;
    const events: RunEvent[] = [];
    const streams: ScriptedStream[] = [];
    const pauses: unknown[] = [];
    const seen = new Set<string>();
    let answered = 0;
    for (;;) {
      let reload = false;
      for await (const event of life.instance.events(runId)) {
        if (event.type === 'stream') streams.push({ mode: event.mode, data: event.data });
        if (event.type === 'interaction') {
          const { interactionId, ...request } = event.interaction;
          // A restored run publishes the pause it waits on again; it is the same pause.
          if (!seen.has(interactionId)) {
            seen.add(interactionId);
            pauses.push(request);
            if (durable !== undefined && !reload) {
              reload = true;
              break;
            }
          }
          const answer = script.answers?.[answered++];
          if (answer === undefined) throw new Error('The run paused with no answer left.');
          const receipt = await life.instance.dispatch({
            instanceId: life.instance.instanceId,
            runId,
            ...event.interaction,
            action: answer.action,
            payload: answer.payload,
          });
          if (receipt.status !== 'accepted') throw new Error('The answer was not accepted.');
        }
        events.push(event);
      }
      if (!reload) break;
      const sessionId = life.instance.sessionId;
      await life.runtime.dispose();
      life.store?.close();
      life = await open(sessionId);
      const restored = await life.instance.restore();
      if (restored === undefined) throw new Error('The stored session was not restored.');
      runId = restored.runId;
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
      unordered: script.unordered === true,
      coldStartMs,
    };
  } finally {
    await life.runtime.dispose();
    life.store?.close();
  }
}
