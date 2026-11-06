// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  type CapabilityPort,
  capabilityBindingPolicy,
  GalaxieError,
  isGalaxieError,
  type ModelPort,
  type ModelPreparation,
  toErrorInfo,
} from '@galaxie/core';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { type StructuredToolInterface, tool } from '@langchain/core/tools';
import type { SerializableSchema } from '@langchain/core/utils/standard_schema';
import {
  type BaseCheckpointSaver,
  type LangGraphRunnableConfig,
  MemorySaver,
  type StateSnapshot,
} from '@langchain/langgraph/web';
import { capabilityToolChecks, RoutedChatModel } from './routed-chat-model.js';
import type { LangGraphTraceHandler } from './trace-handler.js';

type StreamOptions = LangGraphRunnableConfig & {
  streamMode: Array<'values' | 'updates' | 'messages' | 'custom'>;
  subgraphs: true;
};

/** Native runnable boundaries; transform permits draining the engine after abort. */
export interface LangGraphGraph {
  readonly config?: LangGraphRunnableConfig;
  stream(input: unknown, options: StreamOptions): Promise<AsyncIterable<unknown>>;
  transform(input: AsyncGenerator<unknown>, options: StreamOptions): AsyncIterable<unknown>;
  getState(config: LangGraphRunnableConfig): Promise<Pick<StateSnapshot, 'tasks'>>;
}

export type LangGraphAgent = (host: LangGraphHost) => LangGraphGraph;

/** Credential providers are constructed per call; credentials never enter call options (ADR-0006). */
export type LangGraphChatModel =
  | BaseChatModel
  | ((options: { readonly credential: string }) => BaseChatModel);

export interface LangGraphServices {
  /** Provider IDs, rather than role names (ADR-0006). */
  readonly chatModels: Readonly<Record<string, LangGraphChatModel>>;
  readonly checkpointer?: BaseCheckpointSaver;
}

export interface CapabilityToolSpec {
  /** Defaults to the capability name with punctuation replaced by underscores. */
  readonly toolName?: string;
  readonly description: string;
  readonly parameters: SerializableSchema<Record<string, unknown>>;
}

export interface LangGraphHost {
  readonly capabilities: {
    call(name: string, input: unknown, config?: LangGraphRunnableConfig): Promise<unknown>;
  };
  readonly langchain: {
    chatModel(role: string): BaseChatModel;
    /** Offer a broker-backed capability; writes require a host confirmation binding. */
    capabilityTool(name: string, spec: CapabilityToolSpec): StructuredToolInterface;
    checkpointer(): BaseCheckpointSaver;
  };
}

export function createHost(
  services: LangGraphServices,
  capabilities: LangGraphHost['capabilities'],
  models: ModelPreparation | undefined,
  active: () =>
    | {
        readonly capabilities: CapabilityPort;
        readonly models: ModelPort;
        readonly handler: LangGraphTraceHandler;
      }
    | undefined,
): LangGraphHost {
  for (const [providerId, descriptor] of Object.entries(models?.providers ?? {})) {
    const provider = Object.hasOwn(services.chatModels, providerId)
      ? services.chatModels[providerId]
      : undefined;
    if (provider === undefined || (typeof provider === 'function') !== descriptor.credential)
      throw new GalaxieError('invalid', 'The routed model implementations must be valid.');
  }
  const routed = new Map(
    (models?.roles ?? []).map((role) => [
      role,
      new RoutedChatModel(role, services.chatModels, active),
    ]),
  );
  const checkpointer = services.checkpointer ?? new MemorySaver();
  return {
    capabilities,
    langchain: {
      chatModel(role) {
        const model = routed.get(role);
        if (model === undefined)
          throw new GalaxieError('unavailable', 'The requested model role is unavailable.');
        return model;
      },
      capabilityTool(name, spec) {
        const toolName = spec.toolName ?? name.replace(/[^A-Za-z0-9_]/g, '_');
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(toolName))
          throw new GalaxieError('invalid', toErrorInfo('invalid').message);
        const check = (): void => {
          const run = active();
          if (run === undefined) throw new GalaxieError('invalid', toErrorInfo('invalid').message);
          const policy = capabilityBindingPolicy(run.capabilities, name);
          if (
            policy?.kind === 'write' &&
            (policy.approval !== 'confirm' || !policy.confirmationAvailable)
          )
            throw new GalaxieError('invalid', toErrorInfo('invalid').message);
        };
        const capability = tool(
          async (input, config): Promise<unknown> => {
            check();
            try {
              // The adapter forwards this config's full checkpoint namespace to the broker.
              return await capabilities.call(name, input, config);
            } catch (error) {
              if (isGalaxieError(error) && (error.code === 'denied' || error.code === 'invalid'))
                return { error: toErrorInfo(error.code).message };
              throw error;
            }
          },
          { name: toolName, description: spec.description, schema: spec.parameters },
        );
        capabilityToolChecks.set(capability, check);
        return capability;
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
        typeof model === 'function' ||
        (typeof model === 'object' &&
          model !== null &&
          'invoke' in model &&
          typeof model.invoke === 'function'),
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
