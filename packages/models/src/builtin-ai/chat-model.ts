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
  AIMessage,
  AIMessageChunk,
  type BaseMessage,
  type StandardMessageStructure,
} from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import type { Runnable } from '@langchain/core/runnables';
import { ModelError, ModelProviderError } from '../errors.js';
import { mapMessages } from '../messages.js';
import { type OutputSchema, structuredOutput } from '../structured-output.js';
import {
  assertCallable,
  type BuiltInAILanguages,
  expectedLanguages,
  type LanguageModelSession,
} from './api.js';
import { classifyBuiltInAIError } from './classify.js';

export interface BuiltInAIChatModelOptions extends BuiltInAILanguages {}

export interface BuiltInAICallOptions extends BaseChatModelCallOptions {
  readonly jsonSchema?: Readonly<Record<string, unknown>>;
}

/** Stateless, page-side calls to the browser-managed Prompt API model. */
export class BuiltInAIChatModel extends BaseChatModel<BuiltInAICallOptions> {
  readonly #languages: BuiltInAILanguages;

  constructor(options: BuiltInAIChatModelOptions) {
    super({});
    try {
      if (options.inputLanguages.length === 0 || options.outputLanguages.length === 0)
        throw new ModelError('invalid');
      Intl.getCanonicalLocales([...options.inputLanguages]);
      Intl.getCanonicalLocales([...options.outputLanguages]);
    } catch {
      throw new ModelError('invalid');
    }
    this.#languages = {
      inputLanguages: [...options.inputLanguages],
      outputLanguages: [...options.outputLanguages],
    };
  }

  override _llmType(): string {
    return 'builtin-ai';
  }

  override getLsParams(): LangSmithParams {
    return { ls_model_type: 'chat', ls_provider: 'builtin-ai', ls_model_name: 'browser-managed' };
  }

  override async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    let text = '';
    for await (const chunk of this._streamResponseChunks(messages, options, runManager))
      text += chunk.text;
    return {
      generations: [
        {
          text,
          message: new AIMessage<StandardMessageStructure>({
            content: text,
            response_metadata: { finish_reason: 'stop' },
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
    options.signal?.throwIfAborted();
    const api = await assertCallable(this.#languages).catch((error: unknown) => {
      options.signal?.throwIfAborted();
      throw error;
    });
    options.signal?.throwIfAborted();
    let session: LanguageModelSession | undefined;
    let step: 'create' | 'prompt' = 'create';
    try {
      try {
        session = await api.create({
          ...expectedLanguages(this.#languages),
          initialPrompts: mapped.slice(0, -1),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        options.signal?.throwIfAborted();
        step = 'prompt';
        const last = mapped.at(-1);
        const reader = session
          .promptStreaming(last?.content ?? '', {
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            ...(options.jsonSchema === undefined
              ? {}
              : {
                  responseConstraint: options.jsonSchema,
                  omitResponseConstraintInput: true,
                }),
          })
          .getReader();
        try {
          while (true) {
            options.signal?.throwIfAborted();
            const next = await reader.read();
            options.signal?.throwIfAborted();
            if (next.done) break;
            if (next.value.length === 0) continue;
            const chunk = new ChatGenerationChunk({
              text: next.value,
              message: new AIMessageChunk<StandardMessageStructure>({ content: next.value }),
            });
            await runManager?.handleLLMNewToken(
              next.value,
              undefined,
              undefined,
              undefined,
              undefined,
              { chunk },
            );
            options.signal?.throwIfAborted();
            yield chunk;
          }
        } finally {
          reader.releaseLock();
        }
      } finally {
        session?.destroy();
      }
    } catch (error) {
      options.signal?.throwIfAborted();
      const failure = classifyBuiltInAIError(error, step);
      if (failure === undefined) throw new ModelProviderError();
      throw new ModelError(
        failure.code,
        failure.code === 'unavailable' ? failure.reason : undefined,
      );
    }
    options.signal?.throwIfAborted();
    yield new ChatGenerationChunk({
      text: '',
      message: new AIMessageChunk<StandardMessageStructure>({
        content: '',
        response_metadata: { finish_reason: 'stop' },
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
    return structuredOutput(this, schema, config);
  }
}
