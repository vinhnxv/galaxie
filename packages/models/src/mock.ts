// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { BaseChatModel, type LangSmithParams } from '@langchain/core/language_models/chat_models';
import {
  AIMessage,
  AIMessageChunk,
  type BaseMessage,
  type StandardMessageStructure,
  type UsageMetadata,
} from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';

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
      readonly usage?: UsageMetadata;
      readonly wait?: MockLatch;
    }
  | { readonly error: Error };

export type MockScript = Readonly<Record<string, MockScriptEntry>>;

/** Deterministic scripted provider for tests and CI; performs no network requests. */
export class MockChatModel extends BaseChatModel {
  readonly #script: MockScript;
  readonly #provider: string;
  readonly #model: string;
  #calls = 0;

  constructor(
    script: MockScript,
    options: { readonly provider?: string; readonly model?: string } = {},
  ) {
    super({});
    this.#script = script;
    this.#provider = options.provider ?? 'galaxie-mock';
    this.#model = options.model ?? 'mock-1';
  }

  override _llmType(): string {
    return 'galaxie-mock';
  }

  override getLsParams(): LangSmithParams {
    return { ls_model_type: 'chat', ls_provider: this.#provider, ls_model_name: this.#model };
  }

  get calls(): number {
    return this.#calls;
  }

  async #reply(
    messages: BaseMessage[],
    signal?: AbortSignal,
  ): Promise<Exclude<MockScriptEntry, { readonly error: Error }>> {
    this.#calls++;
    const human = messages.findLast((message) => message.type === 'human');
    const entry =
      typeof human?.content === 'string'
        ? Object.hasOwn(this.#script, human.content)
          ? this.#script[human.content]
          : undefined
        : undefined;
    if (entry === undefined)
      throw new MockModelError('The mock has no script for this human message.');
    if ('error' in entry) throw entry.error;
    await entry.wait?.wait(signal);
    signal?.throwIfAborted();
    return entry;
  }

  override async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
  ): Promise<ChatResult> {
    const entry = await this.#reply(messages, options.signal);
    return {
      generations: [
        {
          text: entry.text,
          message: new AIMessage<StandardMessageStructure>({
            id: entry.id,
            content: entry.text,
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
    const entry = await this.#reply(messages, options.signal);
    const words = entry.text.match(/\S+\s*/g) ?? [''];
    for (const [index, word] of words.entries()) {
      options.signal?.throwIfAborted();
      const chunk = new ChatGenerationChunk({
        text: word,
        message: new AIMessageChunk<StandardMessageStructure>({
          id: entry.id,
          content: word,
          ...(index === words.length - 1 && entry.usage !== undefined
            ? { usage_metadata: entry.usage }
            : {}),
        }),
      });
      yield chunk;
      await runManager?.handleLLMNewToken(word, undefined, undefined, undefined, undefined, {
        chunk,
      });
    }
  }
}
