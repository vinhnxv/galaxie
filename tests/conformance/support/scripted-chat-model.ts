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

export class FixtureModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FixtureModelError';
  }
}

export interface ModelLatch {
  readonly entered: Promise<void>;
  release(): void;
  wait(signal?: AbortSignal): Promise<void>;
}

/** A test controls completion; the model's AbortSignal can always interrupt the wait. */
export function createModelLatch(): ModelLatch {
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

export type ModelScriptEntry =
  | {
      readonly id: string;
      readonly text: string;
      readonly usage: UsageMetadata;
      readonly wait?: ModelLatch;
    }
  | { readonly error: FixtureModelError };

export type ModelScript = Readonly<Record<string, ModelScriptEntry>>;

/** Original deterministic fixture shared by native and galaxie conformance lanes. */
export class ScriptedChatModel extends BaseChatModel {
  readonly #script: ModelScript;

  constructor(script: ModelScript) {
    super({});
    this.#script = script;
  }

  override _llmType(): string {
    return 'galaxie-fixture';
  }

  override getLsParams(): LangSmithParams {
    return { ls_model_type: 'chat', ls_provider: 'galaxie-fixture', ls_model_name: 'fixture-1' };
  }

  async #reply(
    messages: BaseMessage[],
    signal?: AbortSignal,
  ): Promise<Exclude<ModelScriptEntry, { readonly error: FixtureModelError }>> {
    const human = messages.findLast((message) => message.type === 'human');
    const entry = typeof human?.content === 'string' ? this.#script[human.content] : undefined;
    if (entry === undefined)
      throw new FixtureModelError('The fixture has no script for this human message.');
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
            usage_metadata: entry.usage,
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
          ...(index === words.length - 1 ? { usage_metadata: entry.usage } : {}),
        }),
      });
      yield chunk;
      await runManager?.handleLLMNewToken(word, undefined, undefined, undefined, undefined, {
        chunk,
      });
    }
  }
}
