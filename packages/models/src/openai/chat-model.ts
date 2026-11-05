// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

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
  AIMessage,
  AIMessageChunk,
  type BaseMessage,
  HumanMessage,
  type StandardMessageStructure,
  SystemMessage,
  type UsageMetadata,
} from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import type { Runnable } from '@langchain/core/runnables';
import { ChatOpenAICompletions } from '@langchain/openai';
import { ModelError, ModelProviderError } from '../errors.js';
import { mapMessages } from '../messages.js';
import { type OutputSchema, structuredOutput } from '../structured-output.js';
import { classifyOpenAIError, type EndpointDestination } from './classify.js';

// Adapter-owned call metadata; callOptions never forwards it to the SDK.
const ROUTED_DESTINATION = Symbol.for('galaxie.model.destination');
const DESTINATIONS: readonly EndpointDestination[] = [
  'in-browser',
  'user-device',
  'user-endpoint',
  'host-server',
  'third-party',
];

export interface OpenAICompatibleOptions {
  readonly baseURL: string;
  readonly model: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: Readonly<Record<string, string>>;
  /** Direct calls default to user-endpoint; routed calls use the selected destination. */
  readonly destination?: EndpointDestination;
}

export interface OpenAICompatibleCallOptions extends BaseChatModelCallOptions {
  readonly jsonSchema?: Readonly<Record<string, unknown>>;
}

function validateOptions(options: OpenAICompatibleOptions): OpenAICompatibleOptions {
  try {
    const url = new URL(options.baseURL);
    if (
      (url.protocol !== 'https:' &&
        !(
          url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        )) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      options.baseURL.includes('?') ||
      options.baseURL.includes('#') ||
      typeof options.model !== 'string' ||
      options.model.trim().length === 0 ||
      (options.maxTokens !== undefined &&
        (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0)) ||
      (options.temperature !== undefined && !Number.isFinite(options.temperature)) ||
      (options.fetch !== undefined && typeof options.fetch !== 'function') ||
      (options.destination !== undefined && !DESTINATIONS.includes(options.destination))
    )
      throw new ModelError('invalid');
    const headers = new Headers(options.headers);
    for (const name of ['authorization', 'cookie', 'host'])
      if (headers.has(name)) throw new ModelError('invalid');
    return { ...options, baseURL: url.href, headers: Object.fromEntries(headers) };
  } catch {
    throw new ModelError('invalid');
  }
}

function cleanMessages(messages: BaseMessage[]): BaseMessage[] {
  return mapMessages(messages).map(({ role, content }) =>
    role === 'system'
      ? new SystemMessage(content)
      : role === 'user'
        ? new HumanMessage(content)
        : new AIMessage(content),
  );
}

function callOptions(
  options: OpenAICompatibleCallOptions,
): ChatOpenAICompletions['ParsedCallOptions'] {
  return {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.jsonSchema === undefined
      ? {}
      : {
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'output', strict: true, schema: options.jsonSchema },
          },
        }),
  };
}

function usageOf(usage: UsageMetadata | undefined): UsageMetadata | undefined {
  if (
    usage === undefined ||
    usage.input_tokens === undefined ||
    usage.output_tokens === undefined ||
    usage.total_tokens === undefined
  )
    return undefined;
  const values = [usage.input_tokens, usage.output_tokens, usage.total_tokens];
  if (!values.every((value) => Number.isSafeInteger(value) && value >= 0))
    throw new ModelProviderError();
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
  };
}

function assertTextReply(message: BaseMessage): string {
  const rawToolCalls = message.additional_kwargs['tool_calls'];
  if (
    message.type !== 'ai' ||
    typeof message.content !== 'string' ||
    (rawToolCalls !== undefined && (!Array.isArray(rawToolCalls) || rawToolCalls.length > 0)) ||
    message.additional_kwargs['function_call'] !== undefined ||
    ('tool_calls' in message &&
      Array.isArray(message.tool_calls) &&
      message.tool_calls.length > 0) ||
    ('invalid_tool_calls' in message &&
      Array.isArray(message.invalid_tool_calls) &&
      message.invalid_tool_calls.length > 0) ||
    ('tool_call_chunks' in message &&
      Array.isArray(message.tool_call_chunks) &&
      message.tool_call_chunks.length > 0)
  )
    throw new ModelProviderError();
  // LangChain drops refusal fields during conversion. Inspect the private raw response,
  // then return fresh messages so no endpoint metadata crosses the wrapper boundary.
  const raw = message.additional_kwargs['__raw_response'] as
    | { choices?: { message?: { refusal?: unknown }; delta?: { refusal?: unknown } }[] }
    | undefined;
  if (raw?.choices?.some((choice) => choice.message?.refusal || choice.delta?.refusal))
    throw new ModelProviderError();
  return message.content;
}

function providerFailure(
  error: unknown,
  endpoint: OpenAICompatibleOptions,
  options: OpenAICompatibleCallOptions,
): Error {
  const selected: unknown = Reflect.get(options, ROUTED_DESTINATION);
  const failure = classifyOpenAIError(
    error,
    typeof selected === 'string' && DESTINATIONS.includes(selected as EndpointDestination)
      ? { baseURL: endpoint.baseURL, destination: selected as EndpointDestination }
      : endpoint,
  );
  return failure === undefined
    ? new ModelProviderError()
    : new ModelError(failure.code, failure.reason);
}

/** One wrapper and one SDK model per router credential lease. Never retains credentials across leases. */
export class OpenAICompatibleChatModel extends BaseChatModel<OpenAICompatibleCallOptions> {
  readonly #inner: ChatOpenAICompletions;
  readonly #endpoint: OpenAICompatibleOptions;

  constructor(options: OpenAICompatibleOptions, credential: string) {
    super({});
    const valid = validateOptions(options);
    this.#endpoint = valid;
    if (typeof credential !== 'string' || credential.trim().length === 0)
      throw new ModelError('invalid');
    try {
      this.#inner = new ChatOpenAICompletions({
        apiKey: credential,
        model: valid.model,
        ...(valid.maxTokens === undefined ? {} : { maxTokens: valid.maxTokens }),
        ...(valid.temperature === undefined ? {} : { temperature: valid.temperature }),
        maxRetries: 0,
        streamUsage: true,
        __includeRawResponse: true,
        configuration: {
          baseURL: valid.baseURL,
          logLevel: 'off',
          organization: null,
          project: null,
          ...(valid.fetch === undefined ? {} : { fetch: valid.fetch }),
          defaultHeaders: valid.headers,
        },
      });
    } catch {
      throw new ModelError('invalid');
    }
  }

  override _llmType(): string {
    return 'openai-compatible';
  }

  override getLsParams(): LangSmithParams {
    return {
      ls_provider: 'openai-compatible',
      ls_model_type: 'chat',
      ls_model_name: 'host-configured',
    };
  }

  override async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
  ): Promise<ChatResult> {
    const mapped = cleanMessages(messages);
    options.signal?.throwIfAborted();
    try {
      const result = await this.#inner._generate(mapped, callOptions(options));
      options.signal?.throwIfAborted();
      if (result.generations.length !== 1) throw new ModelProviderError();
      const message = result.generations[0]?.message;
      if (message === undefined) throw new ModelProviderError();
      const text = assertTextReply(message);
      if (text.length === 0) throw new ModelProviderError();
      // The pinned LangChain converter omits zero counts; read the reported usage directly.
      const raw = message.additional_kwargs['__raw_response'] as
        | {
            usage?: {
              prompt_tokens: number;
              completion_tokens: number;
              total_tokens: number;
            } | null;
          }
        | undefined;
      const reported = raw?.usage;
      const usage = usageOf(
        reported === undefined || reported === null
          ? undefined
          : {
              input_tokens: reported.prompt_tokens,
              output_tokens: reported.completion_tokens,
              total_tokens: reported.total_tokens,
            },
      );
      return {
        generations: [
          {
            text,
            message: new AIMessage<StandardMessageStructure>({
              content: text,
              ...(usage === undefined ? {} : { usage_metadata: usage }),
            }),
          },
        ],
      };
    } catch (error) {
      options.signal?.throwIfAborted();
      throw providerFailure(error, this.#endpoint, options);
    }
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const mapped = cleanMessages(messages);
    options.signal?.throwIfAborted();
    let hasText = false;
    let finished = false;
    try {
      for await (const inner of this.#inner._streamResponseChunks(mapped, callOptions(options))) {
        options.signal?.throwIfAborted();
        const text = assertTextReply(inner.message);
        hasText ||= text.length > 0;
        const reason = inner.generationInfo?.['finish_reason'];
        if (typeof reason === 'string' && reason.length > 0) finished = true;
        const usage = usageOf(
          'usage_metadata' in inner.message
            ? (inner.message.usage_metadata as UsageMetadata | undefined)
            : undefined,
        );
        const chunk = new ChatGenerationChunk({
          text,
          message: new AIMessageChunk<StandardMessageStructure>({
            content: text,
            ...(usage === undefined ? {} : { usage_metadata: usage }),
          }),
        });
        if (text.length > 0)
          await runManager?.handleLLMNewToken(text, undefined, undefined, undefined, undefined, {
            chunk,
          });
        options.signal?.throwIfAborted();
        yield chunk;
      }
      options.signal?.throwIfAborted();
      if (!hasText || !finished) throw new ModelProviderError();
    } catch (error) {
      options.signal?.throwIfAborted();
      throw providerFailure(error, this.#endpoint, options);
    }
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
    return structuredOutput(this, schema, config);
  }
}

export function openAICompatible(
  options: OpenAICompatibleOptions,
): (call: { readonly credential: string }) => OpenAICompatibleChatModel {
  const valid = validateOptions(options);
  return ({ credential }) => new OpenAICompatibleChatModel(valid, credential);
}
