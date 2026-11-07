// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  type CapabilityPort,
  type DestinationClass,
  GalaxieError,
  type ModelCall,
  type ModelFeature,
  type ModelPort,
  type ModelUsage,
  type RunTrace,
  type TraceResult,
} from '@galaxie/core';
import {
  BaseChatModel,
  type BindToolsInput,
  type LangSmithParams,
} from '@langchain/core/language_models/chat_models';
import { type AIMessage, AIMessageChunk, type BaseMessage } from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { RunState } from '../../src/run.js';

export interface SeenCall {
  readonly messages: readonly BaseMessage[];
  readonly options: Record<string | symbol, unknown>;
  readonly tools: readonly string[];
  readonly toolSchemas: readonly Record<string, unknown>[];
}

export type Reply = (call: SeenCall, index: number) => AIMessage | Promise<AIMessage>;

/** Splits a scripted reply into word chunks, then two argument fragments per tool call. */
export function wordChunks(message: AIMessage): AIMessageChunk[] {
  const chunks = (message.text.match(/\S+\s*/g) ?? []).map(
    (word) => new AIMessageChunk({ content: word }),
  );
  for (const [index, call] of (message.tool_calls ?? []).entries()) {
    const args = JSON.stringify(call.args);
    const split = Math.ceil(args.length / 2);
    chunks.push(
      new AIMessageChunk({
        content: '',
        tool_call_chunks: [
          {
            index,
            name: call.name,
            ...(call.id === undefined ? {} : { id: call.id }),
            args: args.slice(0, split),
            type: 'tool_call_chunk',
          },
        ],
      }),
      new AIMessageChunk({
        content: '',
        tool_call_chunks: [{ index, args: args.slice(split), type: 'tool_call_chunk' }],
      }),
    );
  }
  if (chunks.length === 0) chunks.push(new AIMessageChunk({ content: '' }));
  return chunks;
}

/** A scripted chat model that records what the adapter sent it. */
export class FakeChatModel extends BaseChatModel {
  readonly seen: SeenCall[] = [];
  readonly #reply: Reply;
  readonly #split: ((message: AIMessage) => AIMessageChunk[]) | undefined;
  #tools: readonly Record<string, unknown>[] = [];
  #shared: SeenCall[];

  /** With `split`, the model streams the scripted reply as those chunks. */
  constructor(reply: Reply, shared?: SeenCall[], split?: (message: AIMessage) => AIMessageChunk[]) {
    super({});
    this.#reply = reply;
    this.#shared = shared ?? this.seen;
    this.#split = split;
    if (split !== undefined)
      this._streamResponseChunks = async function* (this: FakeChatModel, messages, options) {
        const message = await this.#respond(messages, options);
        for (const chunk of split(message))
          yield new ChatGenerationChunk({ text: chunk.text, message: chunk });
      };
  }

  override _llmType(): string {
    return 'fake';
  }

  override getLsParams(): LangSmithParams {
    return { ls_model_type: 'chat', ls_provider: 'fake', ls_model_name: 'fake-1' };
  }

  override bindTools(tools: BindToolsInput[]): FakeChatModel {
    const bound = new FakeChatModel(this.#reply, this.#shared, this.#split);
    bound.#tools = tools.map((tool) => ({ ...convertToOpenAITool(tool).function }));
    return bound;
  }

  override async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
  ): Promise<ChatResult> {
    const message = await this.#respond(messages, options);
    return { generations: [{ text: message.text, message }] };
  }

  async #respond(messages: BaseMessage[], options: this['ParsedCallOptions']): Promise<AIMessage> {
    const call: SeenCall = {
      messages,
      options: { ...options } as Record<string | symbol, unknown>,
      tools: this.#tools.map((tool) => String(tool['name'])),
      toolSchemas: this.#tools,
    };
    this.#shared.push(call);
    return this.#reply(call, this.#shared.length - 1);
  }
}

export interface FakeLease {
  readonly role: string;
  readonly requires: readonly ModelFeature[] | undefined;
  readonly checked: string[];
  readonly ended: (ModelUsage | undefined)[];
  failed: number;
}

export interface FakeModelsOptions {
  /** Reject a check whose text contains this string with a `denied` error. */
  readonly block?: string;
  readonly destination?: DestinationClass;
  /** Reject `begin` with this error. */
  readonly beginError?: GalaxieError;
  readonly providerId?: string;
  readonly maxTokens?: number;
}

export function fakeModels(options: FakeModelsOptions = {}): {
  readonly port: ModelPort;
  readonly leases: FakeLease[];
} {
  const leases: FakeLease[] = [];
  return {
    leases,
    port: {
      async begin(role, request): Promise<ModelCall> {
        if (options.beginError !== undefined) throw options.beginError;
        const record: FakeLease = {
          role,
          requires: request?.requires,
          checked: [],
          ended: [],
          failed: 0,
        };
        leases.push(record);
        let outcome: ModelCall['outputSafetyOutcome'];
        return {
          providerId: options.providerId ?? 'mock',
          destination: options.destination ?? 'in-browser',
          maxTokens: options.maxTokens ?? 64,
          get outputSafetyOutcome() {
            return outcome;
          },
          async checkOutput(text): Promise<void> {
            record.checked.push(text);
            if (options.block !== undefined && text.includes(options.block)) {
              outcome = 'blocked';
              throw new GalaxieError('denied', 'Policy denied the request.');
            }
            outcome = 'allowed';
          },
          end(usage): void {
            record.ended.push(usage);
          },
          fail(): void {
            record.failed += 1;
          },
        };
      },
    },
  };
}

export interface SpanRecord {
  readonly step: unknown;
  result: TraceResult | undefined;
}

export function fakeTrace(): { readonly trace: RunTrace; readonly spans: SpanRecord[] } {
  const spans: SpanRecord[] = [];
  return {
    spans,
    trace: {
      recordsText: false,
      start(step) {
        const record: SpanRecord = { step, result: undefined };
        spans.push(record);
        return {
          end(result): void {
            record.result ??= result;
          },
        };
      },
    },
  };
}

export function fakeRun(
  models: ModelPort,
  options: {
    readonly steps?: number;
    readonly capabilities?: CapabilityPort;
    readonly signal?: AbortSignal;
  } = {},
): { readonly run: RunState; readonly spans: SpanRecord[] } {
  const { trace, spans } = fakeTrace();
  const span = trace.start({ kind: 'node', name: 'adk.run' });
  return {
    spans,
    run: new RunState(
      {
        capabilities: options.capabilities ?? {
          async call(): Promise<unknown> {
            throw new GalaxieError('unavailable', 'unused');
          },
        },
        models,
        trace,
        limits: { steps: options.steps ?? 8 },
        signal: options.signal ?? new AbortController().signal,
      },
      span,
    ),
  };
}
