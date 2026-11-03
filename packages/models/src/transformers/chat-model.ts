// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import type { StructuredOutputMethodOptions } from '@langchain/core/language_models/base';
import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type LangSmithParams,
} from '@langchain/core/language_models/chat_models';
import {
  AIMessage,
  AIMessageChunk,
  type BaseMessage,
  type StandardMessageStructure,
  type UsageMetadata,
} from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import { ModelError } from '../errors.js';
import { mapMessages } from '../messages.js';
import type { OutputSchema } from '../structured-output.js';
import type { TransformersEngineHandle } from './engine.js';
import type { GenerateRequest } from './protocol.js';

export interface TransformersCallOptions extends BaseChatModelCallOptions {
  readonly maxTokens?: number;
  readonly temperature?: number;
  /** Not supported yet: a call that sets it fails `unsupported`. */
  readonly jsonSchema?: Readonly<Record<string, unknown>>;
}

export interface TransformersChatModelOptions {
  readonly maxTokens?: number;
  readonly temperature?: number;
}

/** Stateless LangChain text chat over one runtime's serialized ONNX Worker engine. */
export class TransformersChatModel extends BaseChatModel<TransformersCallOptions> {
  readonly #handle: TransformersEngineHandle;
  readonly #maxTokens: number;
  readonly #temperature: number;

  constructor(handle: TransformersEngineHandle, options: TransformersChatModelOptions = {}) {
    super({});
    this.#handle = handle;
    this.#maxTokens = options.maxTokens ?? 1024;
    this.#temperature = options.temperature ?? 0;
  }

  override _llmType(): string {
    return 'transformers';
  }

  override getLsParams(): LangSmithParams {
    return {
      ls_model_type: 'chat',
      ls_provider: 'transformers',
      ls_model_name: this.#handle.modelId,
    };
  }

  override async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    let text = '';
    let usage: UsageMetadata | undefined;
    let metadata: Record<string, unknown> = {};
    for await (const chunk of this._streamResponseChunks(messages, options, runManager)) {
      text += chunk.text;
      if ('usage_metadata' in chunk.message)
        usage = chunk.message.usage_metadata as UsageMetadata | undefined;
      metadata = { ...metadata, ...chunk.message.response_metadata };
    }
    return {
      generations: [
        {
          text,
          message: new AIMessage<StandardMessageStructure>({
            content: text,
            response_metadata: metadata,
            ...(usage === undefined ? {} : { usage_metadata: usage }),
          }),
        },
      ],
    };
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    // Only whitelisted options reach the Worker, so unrelated call options never cross.
    if (options.jsonSchema !== undefined) throw new ModelError('unsupported');
    const request: GenerateRequest = {
      messages: mapMessages(messages),
      maxTokens: options.maxTokens ?? this.#maxTokens,
      temperature: options.temperature ?? this.#temperature,
    };
    let usage: UsageMetadata | undefined;
    let finishReason: string | undefined;
    for await (const event of this.#handle.stream(request, options.signal)) {
      if (event.type === 'done') {
        finishReason = event.finishReason;
        usage = {
          input_tokens: event.usage.promptTokens,
          output_tokens: event.usage.completionTokens,
          total_tokens: event.usage.promptTokens + event.usage.completionTokens,
        };
        continue;
      }
      if (event.text.length === 0) continue;
      const output = new ChatGenerationChunk({
        text: event.text,
        message: new AIMessageChunk<StandardMessageStructure>({ content: event.text }),
      });
      await runManager?.handleLLMNewToken(event.text, undefined, undefined, undefined, undefined, {
        chunk: output,
      });
      options.signal?.throwIfAborted();
      yield output;
    }
    options.signal?.throwIfAborted();
    yield new ChatGenerationChunk({
      text: '',
      message: new AIMessageChunk<StandardMessageStructure>({
        content: '',
        response_metadata: finishReason === undefined ? {} : { finish_reason: finishReason },
        ...(usage === undefined ? {} : { usage_metadata: usage }),
      }),
    });
  }

  /** Structured output needs constrained decoding, which this provider does not offer yet. */
  override withStructuredOutput<
    RunOutput extends Record<string, unknown> = Record<string, unknown>,
  >(_schema: OutputSchema<RunOutput>, _config?: StructuredOutputMethodOptions<boolean>): never {
    throw new ModelError('unsupported');
  }
}
