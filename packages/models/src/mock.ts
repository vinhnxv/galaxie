// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
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
  type StandardMessageStructure,
  type ToolCall,
  type ToolCallChunk,
  type UsageMetadata,
} from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';

export class MockModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MockModelError';
  }
}

export interface MockLatch {
  readonly entered: Promise<void>;
  release(): void;
  wait(signal?: AbortSignal): Promise<void>;
}

/** A test controls completion; the model's AbortSignal can always interrupt the wait. */
export function createMockLatch(): MockLatch {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  return {
    entered: entered.promise,
    release: () => released.resolve(),
    async wait(signal) {
      entered.resolve();
      signal?.throwIfAborted();
      const aborted = Promise.withResolvers<never>();
      const onAbort = (): void => aborted.reject(signal?.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        await Promise.race([released.promise, aborted.promise]);
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}

export type MockScriptEntry =
  | {
      readonly id: string;
      readonly text: string;
      readonly toolCalls?: readonly ToolCall[];
      readonly usage?: UsageMetadata;
      readonly wait?: MockLatch;
    }
  | { readonly error: Error };

export type MockScript = Readonly<Record<string, MockScriptEntry | readonly MockScriptEntry[]>>;

/** Structural decision contract: the models package has no dependency on core. */
export interface MockDecisionReply {
  readonly answers: Readonly<
    Record<
      string,
      {
        readonly value: boolean | string | readonly string[] | number;
        readonly probabilities?: Readonly<
          Record<string, number | { readonly yes: number; readonly no: number }>
        >;
        readonly confidence?: number;
      }
    >
  >;
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
}

export type MockDecisionScriptEntry = (
  | MockDecisionReply
  | { readonly invalid: unknown }
  | { readonly error: Error }
) & { readonly wait?: MockLatch };

export interface MockDecisionCall {
  readonly request: unknown;
  readonly signal: AbortSignal;
  readonly maxTokens: number;
}

/** Call-ordered fixtures only: no inference, validation, repair or network activity. */
export class MockDecisionModel {
  readonly #script: readonly MockDecisionScriptEntry[];
  readonly #calls: MockDecisionCall[] = [];

  constructor(script: readonly MockDecisionScriptEntry[]) {
    this.#script = script;
  }

  get calls(): number {
    return this.#calls.length;
  }

  get recordedCalls(): readonly MockDecisionCall[] {
    return [...this.#calls];
  }

  async decide(
    request: unknown,
    options: { readonly signal: AbortSignal; readonly maxTokens: number },
  ): Promise<MockDecisionReply> {
    const entry = this.#script[this.#calls.length];
    this.#calls.push({ request, ...options });
    options.signal.throwIfAborted();
    if (entry === undefined)
      throw new MockModelError('The mock has no script for this decision call.');
    await entry.wait?.wait(options.signal);
    options.signal.throwIfAborted();
    if ('error' in entry) throw entry.error;
    if ('invalid' in entry) return entry.invalid as MockDecisionReply;
    const { answers, usage } = entry;
    return { answers, ...(usage === undefined ? {} : { usage }) };
  }
}

interface MockCallOptions extends BaseChatModelCallOptions {
  readonly maxTokens?: number;
}

/** Deterministic scripted provider for tests and CI; performs no network requests. */
export class MockChatModel extends BaseChatModel<MockCallOptions> {
  readonly #script: MockScript;
  readonly #provider: string;
  readonly #model: string;
  readonly #sequence: 'tool-calls' | 'assistant-turns';
  #counts = { calls: 0 };
  #limits: (number | undefined)[] = [];
  #tools: ReadonlySet<string> = new Set();

  constructor(
    script: MockScript,
    options: {
      readonly provider?: string;
      readonly model?: string;
      /** Count every assistant turn after the last scripted prompt, including text retries. */
      readonly sequence?: 'tool-calls' | 'assistant-turns';
    } = {},
  ) {
    super({});
    this.#script = script;
    this.#provider = options.provider ?? 'galaxie-mock';
    this.#model = options.model ?? 'mock-1';
    this.#sequence = options.sequence ?? 'tool-calls';
  }

  override _llmType(): string {
    return 'galaxie-mock';
  }

  override getLsParams(): LangSmithParams {
    return { ls_model_type: 'chat', ls_provider: this.#provider, ls_model_name: this.#model };
  }

  get calls(): number {
    return this.#counts.calls;
  }

  /** Received limits in dispatch order, separate from scripted replies and transcripts. */
  get maxTokens(): readonly (number | undefined)[] {
    return [...this.#limits];
  }

  override bindTools(tools: BindToolsInput[]): MockChatModel {
    const bound = new MockChatModel(this.#script, {
      provider: this.#provider,
      model: this.#model,
      sequence: this.#sequence,
    });
    bound.#tools = new Set(tools.map((tool) => convertToOpenAITool(tool).function.name));
    bound.#counts = this.#counts;
    bound.#limits = this.#limits;
    return bound;
  }

  async #reply(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
  ): Promise<Exclude<MockScriptEntry, { readonly error: Error }>> {
    this.#counts.calls++;
    this.#limits.push(options.maxTokens);
    const humanIndex = messages.findLastIndex(
      (message) =>
        message.type === 'human' &&
        (this.#sequence === 'tool-calls' ||
          (typeof message.content === 'string' && Object.hasOwn(this.#script, message.content))),
    );
    const human = messages[humanIndex];
    const scripted =
      typeof human?.content === 'string'
        ? Object.hasOwn(this.#script, human.content)
          ? this.#script[human.content]
          : undefined
        : undefined;
    const turns = messages
      .slice(humanIndex + 1)
      .filter(
        (message) =>
          AIMessage.isInstance(message) &&
          (this.#sequence === 'assistant-turns' || (message.tool_calls?.length ?? 0) > 0),
      ).length;
    const entry: MockScriptEntry | undefined = Array.isArray(scripted)
      ? scripted[turns]
      : (scripted as MockScriptEntry | undefined);
    if (entry === undefined)
      throw new MockModelError('The mock has no script for this human message.');
    if ('error' in entry) throw entry.error;
    if (entry.toolCalls?.some((call) => !this.#tools.has(call.name)))
      throw new MockModelError('The mock tool call was not offered.');
    await entry.wait?.wait(options.signal);
    options.signal?.throwIfAborted();
    return entry;
  }

  override async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
  ): Promise<ChatResult> {
    const entry = await this.#reply(messages, options);
    return {
      generations: [
        {
          text: entry.text,
          message: new AIMessage<StandardMessageStructure>({
            id: entry.id,
            content: entry.text,
            ...(entry.toolCalls === undefined ? {} : { tool_calls: [...entry.toolCalls] }),
            ...(entry.usage === undefined ? {} : { usage_metadata: entry.usage }),
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
    const entry = await this.#reply(messages, options);
    const parts: { text: string; calls?: ToolCallChunk[] }[] = (
      entry.text.match(/\S+\s*/g) ?? []
    ).map((text) => ({ text }));
    for (const [index, call] of (entry.toolCalls ?? []).entries()) {
      const args = JSON.stringify(call.args);
      const split = Math.ceil(args.length / 2);
      parts.push(
        {
          text: '',
          calls: [
            {
              index,
              name: call.name,
              ...(call.id === undefined ? {} : { id: call.id }),
              args: args.slice(0, split),
            },
          ],
        },
        { text: '', calls: [{ index, args: args.slice(split) }] },
      );
    }
    if (parts.length === 0) parts.push({ text: '' });
    for (const [index, part] of parts.entries()) {
      options.signal?.throwIfAborted();
      const chunk = new ChatGenerationChunk({
        text: part.text,
        message: new AIMessageChunk<StandardMessageStructure>({
          id: entry.id,
          content: part.text,
          ...(part.calls === undefined ? {} : { tool_call_chunks: part.calls }),
          ...(index === parts.length - 1 && entry.usage !== undefined
            ? { usage_metadata: entry.usage }
            : {}),
        }),
      });
      yield chunk;
      await runManager?.handleLLMNewToken(part.text, undefined, undefined, undefined, undefined, {
        chunk,
      });
    }
  }
}
