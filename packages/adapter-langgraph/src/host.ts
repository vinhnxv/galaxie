// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { GalaxieError } from '@galaxie/core';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  type BaseCheckpointSaver,
  type LangGraphRunnableConfig,
  MemorySaver,
} from '@langchain/langgraph/web';

type StreamOptions = LangGraphRunnableConfig & {
  streamMode: Array<'values' | 'updates' | 'messages' | 'custom'>;
  subgraphs: true;
};

/** Native runnable boundaries; transform permits draining the engine after abort. */
export interface LangGraphGraph {
  readonly config?: LangGraphRunnableConfig;
  stream(input: unknown, options: StreamOptions): Promise<AsyncIterable<unknown>>;
  transform(input: AsyncGenerator<unknown>, options: StreamOptions): AsyncIterable<unknown>;
}

export type LangGraphAgent = (host: LangGraphHost) => LangGraphGraph;

export interface LangGraphServices {
  readonly chatModels: Readonly<Record<string, BaseChatModel>>;
  readonly checkpointer?: BaseCheckpointSaver;
}

export interface LangGraphHost {
  readonly capabilities: {
    call(name: string, input: unknown, config?: LangGraphRunnableConfig): Promise<unknown>;
  };
  readonly langchain: {
    chatModel(role: string): BaseChatModel;
    checkpointer(): BaseCheckpointSaver;
  };
}

export function createHost(
  services: LangGraphServices,
  capabilities: LangGraphHost['capabilities'],
): LangGraphHost {
  const checkpointer = services.checkpointer ?? new MemorySaver();
  return {
    capabilities,
    langchain: {
      chatModel(role) {
        const model = Object.hasOwn(services.chatModels, role)
          ? services.chatModels[role]
          : undefined;
        if (model === undefined)
          throw new GalaxieError('unavailable', 'The requested model role is unavailable.');
        return model;
      },
      checkpointer: () => checkpointer,
    },
  };
}

export function validServices(value: unknown): value is LangGraphServices {
  if (typeof value !== 'object' || value === null || !('chatModels' in value)) return false;
  const models = value.chatModels;
  if (typeof models !== 'object' || models === null || Array.isArray(models)) return false;
  if (
    !Object.values(models).every(
      (model: unknown) =>
        typeof model === 'object' &&
        model !== null &&
        'invoke' in model &&
        typeof model.invoke === 'function',
    )
  )
    return false;
  if (!('checkpointer' in value) || value.checkpointer === undefined) return true;
  const saver = value.checkpointer;
  return (
    typeof saver === 'object' &&
    saver !== null &&
    ['getTuple', 'list', 'put', 'putWrites'].every(
      (key) => key in saver && typeof (saver as Record<string, unknown>)[key] === 'function',
    )
  );
}
