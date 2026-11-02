// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { GalaxieError, type ModelPreparation, toErrorInfo } from '@galaxie/core';
import {
  type BaseAgent,
  type BaseLlm,
  FunctionTool,
  LongRunningFunctionTool,
  requestInputTool,
  type ToolContext,
} from '@google/adk';
import type { ZodObject, ZodRawShape } from 'zod';
import { failure } from './errors.js';
import type { AdkEntry } from './interaction.js';
import { type AdkChatModel, GalaxieLlm } from './llm.js';
import type { RunState } from './run.js';
import { toGalaxieError } from './run.js';

export interface AdkServices {
  /** Provider IDs, rather than role names (ADR-0006). */
  readonly chatModels: Readonly<Record<string, AdkChatModel>>;
}

export interface CapabilityToolSpec {
  /** The function name the model sees; defaults to the capability name with `_` for symbols. */
  readonly toolName?: string;
  readonly description: string;
  readonly parameters: ZodObject<ZodRawShape>;
  /** The tool pauses the run for a host-rendered confirmation before it runs. */
  readonly requireConfirmation?: boolean;
  /** The tool returns a pending status and its result arrives in a later run. */
  readonly longRunning?: boolean;
}

export interface AdkHost {
  readonly capabilities: {
    call(
      name: string,
      input: unknown,
      options?: { readonly signal?: AbortSignal },
    ): Promise<unknown>;
  };
  readonly adk: {
    /** The router-backed model for a declared role (ADR-0006). */
    llm(role: string): BaseLlm;
    /** A tool that calls a bound capability through the broker. */
    capabilityTool(name: string, spec: CapabilityToolSpec): FunctionTool;
    /** ADK's request-input tool, which pauses the run for a user reply. */
    requestInput(): FunctionTool;
  };
}

export type AdkAgent = (host: AdkHost) => BaseAgent | AdkEntry;

/** Models and tools this host created; membership, not ADK's forgeable brand, is the trust check. */
export interface HostRegistry {
  readonly models: WeakSet<object>;
  readonly tools: WeakSet<object>;
}

const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** A capability error that tells the model about its own mistake rather than ending the run. */
const MODEL_VISIBLE: ReadonlySet<string> = new Set(['denied', 'invalid']);

export function validServices(value: unknown): value is AdkServices {
  if (typeof value !== 'object' || value === null || !('chatModels' in value)) return false;
  const models = value.chatModels;
  if (typeof models !== 'object' || models === null || Array.isArray(models)) return false;
  return Object.values(models).every(
    (model: unknown) =>
      typeof model === 'function' ||
      (typeof model === 'object' &&
        model !== null &&
        'invoke' in model &&
        typeof model.invoke === 'function'),
  );
}

function sequenceOf(context: ToolContext): string {
  const { invocationContext, functionCallId } = context;
  const branch = invocationContext.branch ?? '';
  let ordinal = 0;
  for (const event of invocationContext.session.events) {
    const calls = (event.content?.parts ?? []).flatMap((part, position) =>
      part.functionCall === undefined ? [] : [{ id: part.functionCall.id, position }],
    );
    if (calls.length === 0 || (event.branch ?? '') !== branch) continue;
    const match = calls.find((call) => call.id === functionCallId);
    if (match !== undefined)
      return `${branch === '' ? 'root' : branch}/${ordinal}/${match.position}`;
    ordinal += 1;
  }
  throw failure('invalid');
}

export function createHost(
  services: AdkServices,
  models: ModelPreparation | undefined,
  active: () => RunState | undefined,
  conversationId: () => string,
): { readonly host: AdkHost; readonly registry: HostRegistry } {
  for (const [providerId, descriptor] of Object.entries(models?.providers ?? {})) {
    const provider = Object.hasOwn(services.chatModels, providerId)
      ? services.chatModels[providerId]
      : undefined;
    if (provider === undefined || (typeof provider === 'function') !== descriptor.credential)
      throw new GalaxieError('invalid', 'The routed model implementations must be valid.');
  }
  const registry: HostRegistry = { models: new WeakSet(), tools: new WeakSet() };
  const routed = new Map<string, GalaxieLlm>();
  for (const role of models?.roles ?? []) {
    const llm = new GalaxieLlm({
      role,
      providers: services.chatModels,
      active,
      trusted: (tool) => typeof tool === 'object' && tool !== null && registry.tools.has(tool),
    });
    registry.models.add(llm);
    routed.set(role, llm);
  }
  /** Fatal errors are recorded, which aborts the invocation; the error is then thrown. */
  const invoke = async (
    name: string,
    input: unknown,
    options: { signal?: AbortSignal; effectScope?: string },
  ): Promise<unknown> => {
    const run = active();
    if (run === undefined) throw failure('invalid');
    if (run.failure !== undefined) throw run.failure;
    try {
      return await run.capabilities.call(name, input, {
        signal:
          options.signal === undefined ? run.signal : AbortSignal.any([run.signal, options.signal]),
        parent: run.span,
        ...(options.effectScope === undefined ? {} : { effectScope: options.effectScope }),
      });
    } catch (error) {
      const galaxie = toGalaxieError(error, 'unavailable', run.signal);
      if (MODEL_VISIBLE.has(galaxie.code)) throw galaxie;
      throw run.fail(galaxie);
    }
  };
  const host: AdkHost = {
    capabilities: {
      call: (name, input, options) => invoke(name, input, options ?? {}),
    },
    adk: {
      llm(role) {
        const model = routed.get(role);
        if (model === undefined)
          throw new GalaxieError('unavailable', 'The requested model role is unavailable.');
        return model;
      },
      capabilityTool(name, spec) {
        const toolName = spec.toolName ?? name.replace(/[^A-Za-z0-9_]/g, '_');
        if (!TOOL_NAME.test(toolName))
          throw new GalaxieError('invalid', 'The capability tool name must be valid.');
        const options = {
          name: toolName,
          description: spec.description,
          parameters: spec.parameters,
          execute: async (
            input: Record<string, unknown>,
            context?: ToolContext,
          ): Promise<unknown> => {
            const run = active();
            if (run === undefined || context === undefined) throw failure('invalid');
            let effectScope: string;
            try {
              effectScope = `adk/${conversationId()}/${sequenceOf(context)}`;
            } catch (error) {
              throw run.fail(error, 'invalid');
            }
            try {
              return await invoke(name, input, { effectScope });
            } catch (error) {
              // A denial or a validation failure is the model's to see, as a fixed message.
              if (
                run.failure === undefined &&
                error instanceof GalaxieError &&
                MODEL_VISIBLE.has(error.code)
              )
                return { error: toErrorInfo(error.code).message };
              throw error;
            }
          },
          ...(spec.requireConfirmation === true ? { requireConfirmation: true } : {}),
        };
        const tool =
          spec.longRunning === true
            ? new LongRunningFunctionTool(options)
            : new FunctionTool(options);
        registry.tools.add(tool);
        return tool;
      },
      requestInput() {
        registry.tools.add(requestInputTool);
        return requestInputTool as FunctionTool;
      },
    },
  };
  return { host, registry };
}
