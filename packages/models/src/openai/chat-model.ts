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
  type BindToolsInput,
  type LangSmithParams,
} from '@langchain/core/language_models/chat_models';
import {
  AIMessage,
  AIMessageChunk,
  type BaseMessage,
  HumanMessage,
  isAIMessage,
  isAIMessageChunk,
  type StandardMessageStructure,
  SystemMessage,
  type UsageMetadata,
} from '@langchain/core/messages';
import { parsePartialJson } from '@langchain/core/output_parsers';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import type { Runnable } from '@langchain/core/runnables';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { ChatOpenAICompletions } from '@langchain/openai';
import { ModelError, ModelProviderError } from '../errors.js';
import { mapMessages } from '../messages.js';
import { type OutputSchema, structuredOutput } from '../structured-output.js';
import { classifyOpenAIError, type EndpointDestination } from './classify.js';
import { mapToolMessages } from './messages.js';

// Adapter-owned call metadata; callOptions never forwards it to the SDK.
const ROUTED_DESTINATION = Symbol.for('galaxie.model.destination');
const DESTINATIONS: readonly EndpointDestination[] = [
  'in-browser',
  'user-device',
  'user-endpoint',
  'host-server',
  'third-party',
];

// Only bindTools can issue these one-use copy tokens. No credential is retained or re-read.
const copies = new WeakMap<OpenAICompatibleOptions, OpenAICompatibleChatModel>();
type ToolDeclaration = ReturnType<typeof convertToOpenAITool>;
type ToolChoice = ChatOpenAICompletions['ParsedCallOptions']['tool_choice'];

function declarations(tools: readonly BindToolsInput[]): ToolDeclaration[] {
  try {
    return tools.map((tool) => {
      const declared: unknown = JSON.parse(JSON.stringify(convertToOpenAITool(tool)));
      if (typeof declared !== 'object' || declared === null || Array.isArray(declared))
        throw new ModelError('invalid');
      const declaration = declared as ToolDeclaration;
      if (
        declaration.type !== 'function' ||
        typeof declaration.function !== 'object' ||
        declaration.function === null ||
        typeof declaration.function.name !== 'string' ||
        declaration.function.name === ''
      )
        throw new ModelError('invalid');
      return declaration;
    });
  } catch {
    throw new ModelError('invalid');
  }
}

function toolChoice(choice: unknown, tools: readonly ToolDeclaration[]): ToolChoice {
  if (choice === undefined || choice === 'auto' || choice === 'none' || choice === 'required')
    return choice;
  if (typeof choice === 'string' && tools.some((tool) => tool.function.name === choice))
    return choice;
  if (
    typeof choice === 'object' &&
    choice !== null &&
    'type' in choice &&
    choice.type === 'function' &&
    'function' in choice &&
    typeof choice.function === 'object' &&
    choice.function !== null &&
    'name' in choice.function &&
    typeof choice.function.name === 'string'
  ) {
    const name = choice.function.name;
    if (tools.some((tool) => tool.function.name === name))
      return { type: 'function', function: { name } };
  }
  throw new ModelError('unsupported');
}

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
  readonly maxTokens?: number;
  readonly jsonSchema?: Readonly<Record<string, unknown>>;
}

/** The SDK reads token limits from instance fields; keep per-call limits out of shared state. */
class LimitedChatOpenAI extends ChatOpenAICompletions<
  ChatOpenAICompletions['ParsedCallOptions'] & { readonly maxTokens?: number }
> {
  override invocationParams(
    options?: this['ParsedCallOptions'],
    extra?: { streaming?: boolean },
  ): ReturnType<ChatOpenAICompletions['invocationParams']> {
    const params = super.invocationParams(options, extra);
    if (options?.maxTokens !== undefined) {
      if ('max_completion_tokens' in params)
        params.max_completion_tokens = Math.min(
          options.maxTokens,
          params.max_completion_tokens ?? options.maxTokens,
        );
      else params.max_tokens = Math.min(options.maxTokens, params.max_tokens ?? options.maxTokens);
    }
    return params;
  }
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
  tools: ToolDeclaration[] | undefined,
  choice: ToolChoice,
): LimitedChatOpenAI['ParsedCallOptions'] {
  if (
    options.maxTokens !== undefined &&
    (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0)
  )
    throw new ModelError('invalid');
  if (options.jsonSchema !== undefined && tools !== undefined) throw new ModelError('unsupported');
  return {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    ...(tools === undefined ? {} : { tools }),
    ...(choice === undefined ? {} : { tool_choice: choice }),
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

function assertTextReply(message: BaseMessage, toolsEnabled = false): string {
  const rawToolCalls = message.additional_kwargs['tool_calls'];
  if (
    message.type !== 'ai' ||
    typeof message.content !== 'string' ||
    (rawToolCalls !== undefined &&
      (!Array.isArray(rawToolCalls) || (!toolsEnabled && rawToolCalls.length > 0))) ||
    message.additional_kwargs['function_call'] !== undefined ||
    (!toolsEnabled &&
      'tool_calls' in message &&
      Array.isArray(message.tool_calls) &&
      message.tool_calls.length > 0) ||
    (!toolsEnabled &&
      'invalid_tool_calls' in message &&
      Array.isArray(message.invalid_tool_calls) &&
      message.invalid_tool_calls.length > 0) ||
    (!toolsEnabled &&
      'tool_call_chunks' in message &&
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

const MAX_TOOL_CALLS = 16;

function assertToolCalls(
  calls: readonly { readonly name?: string | undefined }[],
  tools: readonly ToolDeclaration[],
): void {
  if (
    calls.length > MAX_TOOL_CALLS ||
    calls.some((call) => !tools.some((tool) => tool.function.name === call.name))
  )
    throw new ModelProviderError();
}

function isArguments(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Streamed arguments that are cut off but that partial parsing would silently complete. */
function isTruncated(args: string | undefined): boolean {
  if (args === undefined || args.trim() === '') return false;
  try {
    JSON.parse(args);
    return false;
  } catch {
    return isArguments(parsePartialJson(args));
  }
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
  readonly #inner: LimitedChatOpenAI;
  readonly #endpoint: OpenAICompatibleOptions;
  #tools: ToolDeclaration[] | undefined;
  #choice: ToolChoice;

  constructor(options: OpenAICompatibleOptions, credential: string) {
    super({});
    const source = copies.get(options);
    if (source !== undefined) {
      copies.delete(options);
      this.#endpoint = source.#endpoint;
      this.#inner = source.#inner;
      return;
    }
    const valid = validateOptions(options);
    this.#endpoint = valid;
    if (typeof credential !== 'string' || credential.trim().length === 0)
      throw new ModelError('invalid');
    try {
      this.#inner = new LimitedChatOpenAI({
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

  /** A model copy offering these declarations, sharing the existing credential-scoped SDK. */
  override bindTools(
    tools: BindToolsInput[],
    kwargs?: Partial<OpenAICompatibleCallOptions>,
  ): OpenAICompatibleChatModel {
    const declared = declarations(tools);
    const choice = toolChoice(kwargs?.tool_choice, declared);
    if (declared.length > 0 && choice !== 'none' && kwargs?.jsonSchema !== undefined)
      throw new ModelError('unsupported');
    const token = { ...this.#endpoint };
    copies.set(token, this);
    const bound = new OpenAICompatibleChatModel(token, '');
    bound.#tools = declared;
    bound.#choice = choice;
    return bound;
  }

  #request(
    messages: BaseMessage[],
    options: OpenAICompatibleCallOptions,
  ): {
    messages: BaseMessage[];
    options: LimitedChatOpenAI['ParsedCallOptions'];
    tools: ToolDeclaration[] | undefined;
  } {
    const choice = toolChoice(
      options.tool_choice === undefined ? this.#choice : options.tool_choice,
      this.#tools ?? [],
    );
    const tools = choice !== 'none' && this.#tools?.length ? this.#tools : undefined;
    return {
      messages: tools === undefined ? cleanMessages(messages) : mapToolMessages(messages),
      // A choice without tools would only make the endpoint reject the request.
      options: callOptions(options, tools, tools === undefined ? undefined : choice),
      tools,
    };
  }

  override async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
  ): Promise<ChatResult> {
    const request = this.#request(messages, options);
    options.signal?.throwIfAborted();
    try {
      const result = await this.#inner._generate(request.messages, request.options);
      options.signal?.throwIfAborted();
      if (result.generations.length !== 1) throw new ModelProviderError();
      const message = result.generations[0]?.message;
      if (message === undefined) throw new ModelProviderError();
      const text = assertTextReply(message, request.tools !== undefined);
      if (!isAIMessage(message)) throw new ModelProviderError();
      const parsed = message.tool_calls ?? [];
      // Arguments that are not a JSON object cannot be a call's input; offer them as invalid.
      const calls = parsed.filter((call) => isArguments(call.args));
      const invalid = [
        ...(message.invalid_tool_calls ?? []),
        ...parsed
          .filter((call) => !isArguments(call.args))
          .map(({ id, name, args }) => ({ id, name, args: JSON.stringify(args) })),
      ];
      if (request.tools !== undefined) assertToolCalls([...calls, ...invalid], request.tools);
      // The history mapper pairs results by ID, so every call needs a distinct, non-empty one.
      const ids = new Set<string>();
      for (const { id } of calls) {
        if (typeof id !== 'string' || id === '' || ids.has(id)) throw new ModelProviderError();
        ids.add(id);
      }
      if (text.length === 0 && calls.length + invalid.length === 0) throw new ModelProviderError();
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
              tool_calls: calls.map(({ id, name, args }) => ({
                type: 'tool_call' as const,
                ...(id === undefined ? {} : { id }),
                name,
                args,
              })),
              invalid_tool_calls: invalid.map(({ id, name, args }) => ({
                type: 'invalid_tool_call' as const,
                ...(id === undefined ? {} : { id }),
                ...(name === undefined ? {} : { name }),
                ...(args === undefined ? {} : { args }),
                error: 'The tool call is malformed.',
              })),
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
    const request = this.#request(messages, options);
    options.signal?.throwIfAborted();
    let hasText = false;
    let finished = false;
    let finishReason: string | undefined;
    let assembled: AIMessageChunk<StandardMessageStructure> | undefined;
    try {
      for await (const inner of this.#inner._streamResponseChunks(
        request.messages,
        request.options,
      )) {
        options.signal?.throwIfAborted();
        const text = assertTextReply(inner.message, request.tools !== undefined);
        const fragments =
          request.tools !== undefined && isAIMessageChunk(inner.message)
            ? inner.message.tool_call_chunks
            : undefined;
        hasText ||= text.length > 0;
        const reason = inner.generationInfo?.['finish_reason'];
        if (typeof reason === 'string' && reason.length > 0) {
          finished = true;
          finishReason = reason;
        }
        const usage = usageOf(
          'usage_metadata' in inner.message
            ? (inner.message.usage_metadata as UsageMetadata | undefined)
            : undefined,
        );
        const chunk = new ChatGenerationChunk({
          text,
          message: new AIMessageChunk<StandardMessageStructure>({
            content: text,
            ...(fragments === undefined
              ? {}
              : {
                  tool_call_chunks: fragments.map(({ index, id, name, args }) => ({
                    type: 'tool_call_chunk' as const,
                    ...(index === undefined ? {} : { index }),
                    ...(id === undefined ? {} : { id }),
                    ...(name === undefined ? {} : { name }),
                    ...(args === undefined ? {} : { args }),
                  })),
                }),
            ...(usage === undefined ? {} : { usage_metadata: usage }),
          }),
        });
        if (request.tools !== undefined && isAIMessageChunk(chunk.message)) {
          assembled = assembled === undefined ? chunk.message : assembled.concat(chunk.message);
          // Names can arrive in pieces, so only the count is checked until the stream ends.
          if ((assembled.tool_call_chunks?.length ?? 0) > MAX_TOOL_CALLS)
            throw new ModelProviderError();
        }
        if (text.length > 0)
          await runManager?.handleLLMNewToken(text, undefined, undefined, undefined, undefined, {
            chunk,
          });
        options.signal?.throwIfAborted();
        yield chunk;
      }
      options.signal?.throwIfAborted();
      const streamed = assembled?.tool_call_chunks ?? [];
      if ((!hasText && streamed.length === 0) || !finished) throw new ModelProviderError();
      if (request.tools !== undefined && streamed.length > 0) {
        assertToolCalls(streamed, request.tools);
        // A reply cut off by the token limit or a filter must not run as a complete call, and
        // consumers repair partial JSON, so truncated arguments fail here.
        if (
          (finishReason !== 'tool_calls' && finishReason !== 'stop') ||
          streamed.some((call) => isTruncated(call.args))
        )
          throw new ModelProviderError();
      }
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
