// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import {
  GalaxieError,
  type ModelCall,
  type ModelPort,
  type ModelUsage,
  type SelectedModelRoute,
  toErrorInfo,
} from '@galaxie/core';
import type { CallbackManagerForLLMRun, Callbacks } from '@langchain/core/callbacks/manager';
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type LangSmithParams,
} from '@langchain/core/language_models/chat_models';
import {
  AIMessageChunk,
  type BaseMessage,
  type BaseMessageLike,
  type StandardMessageStructure,
} from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult, type LLMResult } from '@langchain/core/outputs';
import type { LangGraphServices } from './host.js';
import type { LangGraphTraceHandler } from './trace-handler.js';

const LEASE = Symbol('galaxie.model.lease');
interface ActiveRun {
  readonly models: ModelPort;
  readonly handler: LangGraphTraceHandler;
}
interface CallState {
  readonly lease: ModelCall;
  readonly provider: BaseChatModel;
  readonly handler: LangGraphTraceHandler;
  settled: boolean;
}
const calls = new WeakMap<object, CallState>();

function failure(code: 'invalid' | 'unavailable' | 'unsupported'): GalaxieError {
  return new GalaxieError(code, toErrorInfo(code).message);
}
function token(options: object): object | undefined {
  const value: unknown = Reflect.get(options, LEASE);
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null) throw failure('invalid');
  return value;
}
function usage(message: BaseMessage): ModelUsage | undefined {
  if (!('usage_metadata' in message)) return undefined;
  const value = message.usage_metadata;
  if (
    typeof value !== 'object' ||
    value === null ||
    !('input_tokens' in value) ||
    !('output_tokens' in value)
  )
    return undefined;
  return { inputTokens: value.input_tokens as number, outputTokens: value.output_tokens as number };
}
function finish(call: CallState, successful: boolean, reported?: ModelUsage): void {
  if (call.settled) return;
  call.settled = true;
  if (successful) call.lease.end(reported);
  else call.lease.fail();
}
export function selectedRouteFromOptions(options: unknown): SelectedModelRoute | undefined {
  if (typeof options !== 'object' || options === null) return undefined;
  const carrier: unknown = Reflect.get(options, LEASE);
  if (typeof carrier !== 'object' || carrier === null) return undefined;
  const lease = calls.get(carrier)?.lease;
  return lease === undefined
    ? undefined
    : { providerId: lease.providerId, destination: lease.destination };
}

/** One LangChain run around a model selected by the run-bound policy port (ADR-0006). */
export class RoutedChatModel extends BaseChatModel {
  readonly #role: string;
  readonly #providers: LangGraphServices['chatModels'];
  readonly #active: () => ActiveRun | undefined;

  constructor(
    role: string,
    providers: LangGraphServices['chatModels'],
    active: () => ActiveRun | undefined,
  ) {
    super({});
    this.#role = role;
    this.#providers = providers;
    this.#active = active;
  }

  override _llmType(): string {
    return 'galaxie-routed';
  }

  async #begin(options: Partial<BaseChatModelCallOptions> | undefined): Promise<CallState> {
    const run = this.#active();
    if (run === undefined) throw failure('invalid');
    const lease = await run.models.begin(
      this.#role,
      options?.signal === undefined ? undefined : { signal: options.signal },
    );
    try {
      const implementation = Object.hasOwn(this.#providers, lease.providerId)
        ? this.#providers[lease.providerId]
        : undefined;
      if (implementation === undefined) throw failure('unavailable');
      if (typeof implementation === 'function' && lease.credential === undefined)
        throw failure('invalid');
      const provider =
        typeof implementation === 'function'
          ? implementation({ credential: lease.credential as string })
          : implementation;
      return { lease, provider, handler: run.handler, settled: false };
    } catch (error) {
      lease.fail();
      throw error;
    }
  }

  async #take(options: this['ParsedCallOptions']): Promise<CallState> {
    const carrier = token(options);
    if (carrier === undefined) return this.#begin(options);
    const call = calls.get(carrier);
    if (call === undefined) throw failure('invalid');
    calls.delete(carrier);
    return call;
  }

  override getLsParams(options: this['ParsedCallOptions']): LangSmithParams {
    const carrier = token(options);
    if (carrier === undefined) return super.getLsParams(options);
    const call = calls.get(carrier);
    if (call === undefined) throw failure('invalid');
    return call.provider.getLsParams(options);
  }

  override async generate(
    messages: BaseMessageLike[][],
    options?: string[] | Partial<BaseChatModelCallOptions>,
    callbacks?: Callbacks,
  ): Promise<LLMResult> {
    if (messages.length > 1) throw failure('unsupported');
    const parsed = Array.isArray(options) ? { stop: options } : options;
    const call = await this.#begin(parsed);
    const carrier = Object.freeze({});
    calls.set(carrier, call);
    const leasedOptions = { ...parsed, [LEASE]: carrier };
    try {
      const result = await super.generate(messages, leasedOptions, callbacks);
      return result;
    } finally {
      calls.delete(carrier);
      finish(call, false);
    }
  }

  override async *_streamIterator(
    input: BaseLanguageModelInput,
    options?: Partial<BaseChatModelCallOptions>,
  ): AsyncGenerator<AIMessageChunk> {
    if (this.disableStreaming) {
      yield await this.invoke(input, options);
      return;
    }
    const call = await this.#begin(options);
    const carrier = Object.freeze({});
    calls.set(carrier, call);
    const leasedOptions = { ...options, [LEASE]: carrier };
    try {
      yield* super._streamIterator(input, leasedOptions);
    } finally {
      calls.delete(carrier);
      finish(call, false);
    }
  }

  override async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const call = await this.#take(options);
    try {
      if (runManager !== undefined) call.handler.setModelRoute(runManager.runId, call.lease);
      const result = await call.provider._generate(messages, options, runManager);
      finish(
        call,
        true,
        result.generations[0] === undefined ? undefined : usage(result.generations[0].message),
      );
      return result;
    } finally {
      finish(call, false);
    }
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const call = await this.#take(options);
    try {
      if (runManager !== undefined) call.handler.setModelRoute(runManager.runId, call.lease);
      let reported: ModelUsage | undefined;
      const chunks =
        call.provider._streamResponseChunks === BaseChatModel.prototype._streamResponseChunks
          ? this.#generateChunk(call.provider, messages, options, runManager)
          : call.provider._streamResponseChunks(messages, options, runManager);
      for await (const chunk of chunks) {
        const current = usage(chunk.message);
        if (current !== undefined)
          reported = {
            inputTokens: (reported?.inputTokens ?? 0) + current.inputTokens,
            outputTokens: (reported?.outputTokens ?? 0) + current.outputTokens,
          };
        yield chunk;
      }
      finish(call, true, reported);
    } finally {
      finish(call, false);
    }
  }

  async *#generateChunk(
    provider: BaseChatModel,
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const result = await provider._generate(messages, options, runManager);
    const generation = result.generations[0];
    if (generation === undefined) return;
    const chunk = new ChatGenerationChunk({
      text: generation.text,
      message: new AIMessageChunk<StandardMessageStructure>({ ...generation.message }),
      ...(generation.generationInfo === undefined
        ? {}
        : { generationInfo: generation.generationInfo }),
    });
    yield chunk;
    await runManager?.handleLLMNewToken(chunk.text, undefined, undefined, undefined, undefined, {
      chunk,
    });
  }
}
