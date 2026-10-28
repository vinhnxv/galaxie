// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import type {
  BaseLanguageModelInput,
  StructuredOutputMethodOptions,
} from '@langchain/core/language_models/base';
import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type LangSmithParams,
} from '@langchain/core/language_models/chat_models';
import {
  assembleStructuredOutputPipeline,
  createContentParser,
} from '@langchain/core/language_models/structured_output';
import {
  AIMessage,
  AIMessageChunk,
  type BaseMessage,
  type StandardMessageStructure,
  type UsageMetadata,
} from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import { type Runnable, RunnableLambda } from '@langchain/core/runnables';
import { toJsonSchema } from '@langchain/core/utils/json_schema';
import type { SerializableSchema } from '@langchain/core/utils/standard_schema';
import type { InteropZodType } from '@langchain/core/utils/types';
import { WebLLMError, WebLLMProviderError } from '../errors.js';
import type { WebLLMEngineHandle, WebLLMRequest } from './engine.js';

export interface WebLLMCallOptions extends BaseChatModelCallOptions {
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly jsonSchema?: Readonly<Record<string, unknown>>;
}

export interface WebLLMChatModelOptions {
  readonly maxTokens?: number;
  readonly temperature?: number;
}

type OutputSchema<Output extends Record<string, unknown>> =
  | SerializableSchema<Output>
  | InteropZodType<Output>
  | Record<string, unknown>;

function textContent(message: BaseMessage): string {
  if (typeof message.content === 'string') return message.content;
  if (message.content.every((block) => block.type === 'text' && typeof block.text === 'string'))
    return message.content.map((block) => block.text).join('');
  throw new WebLLMError('invalid');
}

function mapMessages(messages: BaseMessage[]): WebLLMRequest['messages'] {
  if (messages.length === 0 || messages.at(-1)?.type !== 'human') throw new WebLLMError('invalid');
  return messages.map((message, index) => {
    if (
      (message.type === 'system' && index !== 0) ||
      ('tool_calls' in message &&
        Array.isArray(message.tool_calls) &&
        message.tool_calls.length > 0) ||
      ('invalid_tool_calls' in message &&
        Array.isArray(message.invalid_tool_calls) &&
        message.invalid_tool_calls.length > 0) ||
      message.additional_kwargs['tool_calls'] !== undefined ||
      message.additional_kwargs['function_call'] !== undefined
    )
      throw new WebLLMError('invalid');
    const role =
      message.type === 'human'
        ? 'user'
        : message.type === 'ai'
          ? 'assistant'
          : message.type === 'system'
            ? 'system'
            : undefined;
    if (role === undefined) throw new WebLLMError('invalid');
    return { role, content: textContent(message) };
  });
}

function responseFormat(schema: WebLLMCallOptions['jsonSchema']): WebLLMRequest['response_format'] {
  if (schema === undefined) return undefined;
  try {
    if (schema === null || typeof schema !== 'object' || Array.isArray(schema))
      throw new WebLLMError('invalid');
    return { type: 'json_object', schema: JSON.stringify(schema) };
  } catch {
    throw new WebLLMError('invalid');
  }
}

/** Stateless LangChain chat calls over one runtime's serialized worker engine. */
export class WebLLMChatModel extends BaseChatModel<WebLLMCallOptions> {
  readonly #handle: WebLLMEngineHandle;
  readonly #maxTokens: number;
  readonly #temperature: number;

  constructor(handle: WebLLMEngineHandle, options: WebLLMChatModelOptions = {}) {
    super({});
    this.#handle = handle;
    this.#maxTokens = options.maxTokens ?? 1024;
    this.#temperature = options.temperature ?? 0;
  }

  override _llmType(): string {
    return 'webllm';
  }

  override getLsParams(): LangSmithParams {
    return { ls_model_type: 'chat', ls_provider: 'webllm', ls_model_name: this.#handle.modelId };
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
    const mapped = mapMessages(messages);
    const format = responseFormat(options.jsonSchema);
    const request: WebLLMRequest = {
      messages: mapped,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: options.maxTokens ?? this.#maxTokens,
      temperature: options.temperature ?? this.#temperature,
      ...(format === undefined ? {} : { response_format: format }),
    };
    let usage: UsageMetadata | undefined;
    let finishReason: string | undefined;
    for await (const chunk of this.#handle.stream(request, options.signal)) {
      const choice = chunk.choices[0];
      if (
        choice?.finish_reason !== null &&
        choice?.finish_reason !== undefined &&
        ['stop', 'length', 'tool_calls', 'abort'].includes(choice.finish_reason)
      )
        finishReason = choice.finish_reason;
      if (chunk.usage !== undefined && chunk.usage !== null)
        usage = {
          input_tokens: chunk.usage.prompt_tokens,
          output_tokens: chunk.usage.completion_tokens,
          total_tokens: chunk.usage.prompt_tokens + chunk.usage.completion_tokens,
        };
      const text = choice?.delta.content;
      if (typeof text !== 'string' || text.length === 0) continue;
      const output = new ChatGenerationChunk({
        text,
        message: new AIMessageChunk<StandardMessageStructure>({ content: text }),
      });
      await runManager?.handleLLMNewToken(text, undefined, undefined, undefined, undefined, {
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

  override withStructuredOutput<
    RunOutput extends Record<string, unknown> = Record<string, unknown>,
  >(
    schema: OutputSchema<RunOutput>,
    config?: StructuredOutputMethodOptions<false>,
  ): Runnable<BaseLanguageModelInput, RunOutput>;
  override withStructuredOutput<
    RunOutput extends Record<string, unknown> = Record<string, unknown>,
  >(
    schema: OutputSchema<RunOutput>,
    config?: StructuredOutputMethodOptions<true>,
  ): Runnable<BaseLanguageModelInput, { raw: BaseMessage; parsed: RunOutput }>;
  override withStructuredOutput<
    RunOutput extends Record<string, unknown> = Record<string, unknown>,
  >(
    schema: OutputSchema<RunOutput>,
    config?: StructuredOutputMethodOptions<boolean>,
  ):
    | Runnable<BaseLanguageModelInput, RunOutput>
    | Runnable<BaseLanguageModelInput, { raw: BaseMessage; parsed: RunOutput }> {
    if (config?.method !== undefined && config.method !== 'jsonSchema')
      throw new WebLLMError('unsupported');
    let jsonSchema: Readonly<Record<string, unknown>>;
    try {
      jsonSchema = toJsonSchema(schema as Parameters<typeof toJsonSchema>[0]);
    } catch {
      throw new WebLLMError('invalid');
    }
    const parser = createContentParser<RunOutput>(schema);
    const safeParser = RunnableLambda.from<BaseMessage, RunOutput>(async (message) => {
      try {
        if (typeof message.content !== 'string') throw new WebLLMProviderError();
        // Avoid invoking parser callbacks with its content-bearing OutputParserException.
        return await parser.parseResult([{ text: message.content }]);
      } catch {
        throw new WebLLMProviderError();
      }
    });
    return assembleStructuredOutputPipeline(
      this.withConfig({ jsonSchema }),
      safeParser,
      config?.includeRaw,
    );
  }
}
