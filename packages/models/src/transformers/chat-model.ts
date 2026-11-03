// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import type { StructuredOutputMethodOptions } from '@langchain/core/language_models/base';
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
  type InvalidToolCall,
  type StandardMessageStructure,
  type ToolCall,
  type UsageMetadata,
} from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { ModelError } from '../errors.js';
import { mapMessages } from '../messages.js';
import type { OutputSchema } from '../structured-output.js';
import type { TransformersStreamEvent } from './engine.js';
import { mapToolMessages } from './messages.js';
import type { GenerateRequest, JsonObject } from './protocol.js';
import {
  type InvalidToolBlock,
  type ParsedToolCall,
  ToolBlockSplitter,
  type ToolItem,
} from './tool-parser.js';

/**
 * What the chat model needs from an engine. A loaded handle satisfies it; a host that loads
 * lazily, after a download decision, passes its own object with the same two members.
 */
export interface TransformersChatEngine {
  readonly modelId: string;
  /** The record's tool-call format; without one `bindTools` fails `unsupported`. */
  readonly toolFormat?: 'hermes' | undefined;
  stream(request: GenerateRequest, signal?: AbortSignal): AsyncGenerator<TransformersStreamEvent>;
}

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

type ModelEvent =
  | ToolItem
  | {
      readonly kind: 'done';
      readonly usage: UsageMetadata;
      readonly finishReason: string;
    };

/** Tool declarations as plain JSON, so a schema library's undefined fields never reach the Worker. */
function declarations(tools: readonly BindToolsInput[]): readonly JsonObject[] {
  try {
    return tools.map((tool) => {
      const declared: unknown = JSON.parse(JSON.stringify(convertToOpenAITool(tool)));
      if (typeof declared !== 'object' || declared === null || Array.isArray(declared))
        throw new ModelError('invalid');
      return declared as JsonObject;
    });
  } catch (error) {
    throw error instanceof ModelError ? error : new ModelError('invalid');
  }
}

/** Only `auto` (or none given) and `none` are possible: forcing a call needs constrained decoding. */
function toolsEnabled(choice: unknown): boolean {
  if (choice === undefined || choice === 'auto') return true;
  if (choice === 'none') return false;
  throw new ModelError('unsupported');
}

function chunkOf(item: ParsedToolCall | InvalidToolBlock) {
  return {
    type: 'tool_call_chunk' as const,
    index: item.index,
    id: item.id,
    ...(item.kind === 'call'
      ? { name: item.name, args: JSON.stringify(item.args) }
      : { ...(item.name === undefined ? {} : { name: item.name }), args: item.args }),
  };
}

/** Stateless LangChain chat over one runtime's serialized ONNX Worker engine. */
export class TransformersChatModel extends BaseChatModel<TransformersCallOptions> {
  readonly #handle: TransformersChatEngine;
  readonly #maxTokens: number;
  readonly #temperature: number;
  #tools: readonly JsonObject[] | undefined;

  constructor(handle: TransformersChatEngine, options: TransformersChatModelOptions = {}) {
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

  /**
   * A copy of this model that offers `tools` to the template. The record must declare a tool
   * format, and `tool_choice` may only leave the choice to the model or turn the tools off.
   */
  override bindTools(
    tools: BindToolsInput[],
    kwargs?: Partial<TransformersCallOptions>,
  ): TransformersChatModel {
    if (this.#handle.toolFormat === undefined) throw new ModelError('unsupported');
    const enabled = toolsEnabled(kwargs?.tool_choice);
    const bound = new TransformersChatModel(this.#handle, {
      maxTokens: this.#maxTokens,
      temperature: this.#temperature,
    });
    bound.#tools = enabled && tools.length > 0 ? declarations(tools) : undefined;
    return bound;
  }

  /** The reply as text, parsed tool calls and one closing event, after the request is checked. */
  async *#events(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
  ): AsyncGenerator<ModelEvent> {
    // Only whitelisted options reach the Worker, so unrelated call options never cross.
    if (options.jsonSchema !== undefined) throw new ModelError('unsupported');
    const tools = toolsEnabled(options.tool_choice) ? this.#tools : undefined;
    const request: GenerateRequest = {
      messages:
        this.#handle.toolFormat === undefined ? mapMessages(messages) : mapToolMessages(messages),
      ...(tools === undefined ? {} : { tools }),
      maxTokens: options.maxTokens ?? this.#maxTokens,
      temperature: options.temperature ?? this.#temperature,
    };
    // Tool markup is parsed only when tools were offered; otherwise the reply is plain text.
    const splitter = tools === undefined ? undefined : new ToolBlockSplitter();
    let blocks = 0;
    const items = function* (found: readonly ToolItem[]): Generator<ToolItem> {
      for (const item of found) {
        if (item.kind !== 'text') blocks += 1;
        yield item;
      }
    };
    for await (const event of this.#handle.stream(request, options.signal)) {
      if (event.type === 'chunk') {
        if (event.text.length === 0) continue;
        if (splitter === undefined) yield { kind: 'text', text: event.text };
        else yield* items(splitter.push(event.text));
        continue;
      }
      if (splitter !== undefined) yield* items(splitter.finish());
      // A reply cut off by the token limit says so even when it holds a broken block.
      const finishReason =
        event.finishReason !== 'length' && blocks > 0 ? 'tool_calls' : event.finishReason;
      yield {
        kind: 'done',
        finishReason,
        usage: {
          input_tokens: event.usage.promptTokens,
          output_tokens: event.usage.completionTokens,
          total_tokens: event.usage.promptTokens + event.usage.completionTokens,
        },
      };
    }
    options.signal?.throwIfAborted();
  }

  async #token(runManager: CallbackManagerForLLMRun | undefined, text: string): Promise<void> {
    const chunk = new ChatGenerationChunk({
      text,
      message: new AIMessageChunk<StandardMessageStructure>({ content: text }),
    });
    await runManager?.handleLLMNewToken(text, undefined, undefined, undefined, undefined, {
      chunk,
    });
  }

  override async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    let text = '';
    const calls: ToolCall[] = [];
    const invalid: InvalidToolCall[] = [];
    let usage: UsageMetadata | undefined;
    let metadata: Record<string, unknown> = {};
    for await (const event of this.#events(messages, options)) {
      if (event.kind === 'text') {
        text += event.text;
        await this.#token(runManager, event.text);
        options.signal?.throwIfAborted();
      } else if (event.kind === 'call') {
        calls.push({ type: 'tool_call', id: event.id, name: event.name, args: event.args });
      } else if (event.kind === 'invalid') {
        invalid.push({
          type: 'invalid_tool_call',
          id: event.id,
          ...(event.name === undefined ? {} : { name: event.name }),
          args: event.args,
          error: 'The tool call is malformed.',
        });
      } else {
        usage = event.usage;
        metadata = { finish_reason: event.finishReason };
      }
    }
    return {
      generations: [
        {
          text,
          message: new AIMessage<StandardMessageStructure>({
            content: text,
            ...(calls.length === 0 ? {} : { tool_calls: calls }),
            ...(invalid.length === 0 ? {} : { invalid_tool_calls: invalid }),
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
    let done: Extract<ModelEvent, { kind: 'done' }> | undefined;
    for await (const event of this.#events(messages, options)) {
      if (event.kind === 'done') {
        done = event;
        continue;
      }
      if (event.kind === 'text') {
        const output = new ChatGenerationChunk({
          text: event.text,
          message: new AIMessageChunk<StandardMessageStructure>({ content: event.text }),
        });
        await runManager?.handleLLMNewToken(
          event.text,
          undefined,
          undefined,
          undefined,
          undefined,
          { chunk: output },
        );
        options.signal?.throwIfAborted();
        yield output;
        continue;
      }
      // Each complete block arrives once, with its own index; a malformed one carries its raw
      // text as the argument string, so a reader that rebuilds calls can compare the two.
      options.signal?.throwIfAborted();
      yield new ChatGenerationChunk({
        text: '',
        message: new AIMessageChunk<StandardMessageStructure>({
          content: '',
          tool_call_chunks: [chunkOf(event)],
        }),
      });
    }
    options.signal?.throwIfAborted();
    yield new ChatGenerationChunk({
      text: '',
      message: new AIMessageChunk<StandardMessageStructure>({
        content: '',
        response_metadata: done === undefined ? {} : { finish_reason: done.finishReason },
        ...(done === undefined ? {} : { usage_metadata: done.usage }),
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
