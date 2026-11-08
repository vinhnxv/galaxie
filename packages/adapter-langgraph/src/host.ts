// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  type CapabilityPort,
  capabilityBindingPolicy,
  type DecisionProvider,
  type DecisionRequest,
  type DecisionResult,
  GalaxieError,
  isGalaxieError,
  type ModelPort,
  type ModelPreparation,
  toErrorInfo,
} from '@galaxie-ai/core';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { DynamicStructuredTool, type StructuredToolInterface } from '@langchain/core/tools';
import type { InteropZodObject } from '@langchain/core/utils/types';
import {
  type BaseCheckpointSaver,
  type LangGraphRunnableConfig,
  MemorySaver,
  type StateSnapshot,
} from '@langchain/langgraph/web';
import { capabilityToolChecks, RoutedChatModel } from './routed-chat-model.js';
import { routedDecision } from './routed-decision.js';
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
  /** Decision provider IDs, with credentials supplied through call-scoped factories. */
  readonly decisionModels?: Readonly<Record<string, DecisionProvider>>;
  readonly checkpointer?: BaseCheckpointSaver;
}

export interface CapabilityToolSpec {
  /** Defaults to the capability name with punctuation replaced by underscores. */
  readonly toolName?: string;
  readonly description: string;
  readonly parameters: InteropZodObject;
}

export interface LangGraphHost {
  readonly capabilities: {
    call(name: string, input: unknown, config?: LangGraphRunnableConfig): Promise<unknown>;
  };
  readonly langchain: {
    chatModel(role: string): BaseChatModel;
    decide(
      role: string,
      request: DecisionRequest,
      config?: LangGraphRunnableConfig,
    ): Promise<DecisionResult['answers']>;
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
        readonly signal?: AbortSignal;
        readonly payload?: (value: unknown) => string;
      }
    | undefined,
): LangGraphHost {
  for (const [providerId, descriptor] of Object.entries(models?.providers ?? {})) {
    const implementations =
      descriptor.modality === 'decision' ? (services.decisionModels ?? {}) : services.chatModels;
    const provider = Object.hasOwn(implementations, providerId)
      ? implementations[providerId]
      : undefined;
    if (provider === undefined || (typeof provider === 'function') !== descriptor.credential)
      throw new GalaxieError('invalid', 'The routed model implementations must be valid.');
  }
  const decisions = new Set(models?.decisionRoles ?? []);
  const routed = new Map(
    (models?.roles ?? [])
      .filter((role) => !decisions.has(role))
      .map((role) => [role, new RoutedChatModel(role, services.chatModels, active)]),
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
      async decide(role, request, config) {
        if (!decisions.has(role) || !models?.roles.includes(role))
          throw new GalaxieError('unavailable', toErrorInfo('unavailable').message);
        return routedDecision(role, request, config, services.decisionModels ?? {}, active());
      },
      capabilityTool(name, spec) {
        const toolName = spec.toolName ?? name.replace(/[^A-Za-z0-9_]/g, '_');
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(toolName))
          throw new GalaxieError('invalid', toErrorInfo('invalid').message);
        const check = (): void => {
          const run = active();
          if (run === undefined) throw new GalaxieError('invalid', toErrorInfo('invalid').message);
          const policy = capabilityBindingPolicy(run.capabilities, name);
          // Fail closed: a capability without a broker policy, or any effectful kind that does
          // not require a configured host confirmation, is never offered or run as a tool.
          if (
            policy === undefined ||
            (policy.kind !== 'read' &&
              (policy.approval !== 'confirm' || !policy.confirmationAvailable))
          )
            throw new GalaxieError('invalid', toErrorInfo('invalid').message);
        };
        const capability = new DynamicStructuredTool({
          name: toolName,
          description: spec.description,
          schema: spec.parameters,
          func: async (input, _runManager, config): Promise<unknown> => {
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
        });
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
  if ('decisionModels' in value && value.decisionModels !== undefined) {
    const decisions = value.decisionModels;
    if (
      typeof decisions !== 'object' ||
      decisions === null ||
      Array.isArray(decisions) ||
      !Object.values(decisions).every(
        (model: unknown) =>
          typeof model === 'function' ||
          (typeof model === 'object' &&
            model !== null &&
            'decide' in model &&
            typeof model.decide === 'function'),
      )
    )
      return false;
  }
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
