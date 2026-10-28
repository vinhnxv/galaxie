// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

// A LangChain chat model over the inference worker. Graph nodes call the in-browser model the way
// they would call any other LangChain provider, so the graph does not know where the model runs.
// Like a hosted provider's native structured output (ChatOpenAI's response_format), the jsonSchema
// call option makes the reply one JSON value that matches the schema.

import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BaseChatModelParams,
} from '@langchain/core/language_models/chat_models';
import { AIMessage, AIMessageChunk, type BaseMessage } from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import type { EngineClient, GenerateResult } from '../engine/client.js';
import type { ChatTurn, GenerateRequest, GenerationStats, JsonSchema } from '../engine/protocol.js';

export interface ChatWebGpuCallOptions extends BaseChatModelCallOptions {
  readonly maxNewTokens?: number;
  readonly jsonSchema?: JsonSchema;
}

function toTurns(messages: readonly BaseMessage[]): ChatTurn[] {
  return messages.map((message) => {
    const type = message.getType();
    const role =
      type === 'system'
        ? 'system'
        : type === 'human'
          ? 'user'
          : type === 'ai'
            ? 'assistant'
            : undefined;
    if (role === undefined) {
      throw new Error(`messages of type ${type} are not supported`);
    }
    return { role, content: message.text };
  });
}

export class ChatWebGpu extends BaseChatModel<ChatWebGpuCallOptions> {
  readonly #engine: EngineClient;
  readonly #maxNewTokens: number;

  constructor(engine: EngineClient, fields: BaseChatModelParams & { maxNewTokens?: number } = {}) {
    super(fields);
    this.#engine = engine;
    this.#maxNewTokens = fields.maxNewTokens ?? 512;
  }

  override _llmType(): string {
    return 'galaxie-spike-webgpu';
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    // Aborts the request when the caller stops reading before the model finished.
    const stop = new AbortController();
    const signal =
      options.signal === undefined ? stop.signal : AbortSignal.any([options.signal, stop.signal]);
    const deltas: string[] = [];
    let wake: (() => void) | undefined;
    let outcome: { result: GenerateResult } | { error: unknown } | undefined;
    const request: GenerateRequest = {
      messages: toTurns(messages),
      maxNewTokens: options.maxNewTokens ?? this.#maxNewTokens,
      ...(options.jsonSchema === undefined ? {} : { jsonSchema: options.jsonSchema }),
    };
    this.#engine
      .generate(
        request,
        (delta) => {
          deltas.push(delta);
          wake?.();
        },
        signal,
      )
      .then(
        (result) => {
          outcome = { result };
        },
        (error: unknown) => {
          outcome = { error };
        },
      )
      .finally(() => wake?.());
    try {
      while (true) {
        for (let delta = deltas.shift(); delta !== undefined; delta = deltas.shift()) {
          yield new ChatGenerationChunk({
            text: delta,
            message: new AIMessageChunk({ content: delta }),
          });
          await runManager?.handleLLMNewToken(delta);
        }
        if (outcome !== undefined) {
          break;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
      if ('error' in outcome) {
        throw outcome.error;
      }
      const { stats } = outcome.result;
      yield new ChatGenerationChunk({
        text: '',
        message: new AIMessageChunk({ content: '', response_metadata: { stats } }),
      });
    } finally {
      if (outcome === undefined) {
        stop.abort();
      }
    }
  }

  override async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    let text = '';
    let stats: GenerationStats | undefined;
    for await (const chunk of this._streamResponseChunks(messages, options, runManager)) {
      text += chunk.text;
      stats = (chunk.message.response_metadata['stats'] as GenerationStats | undefined) ?? stats;
    }
    const message = new AIMessage({
      content: text,
      response_metadata: stats === undefined ? {} : { stats },
    });
    return { generations: [{ text, message }] };
  }
}
