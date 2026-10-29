// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import {
  GalaxieError,
  type ModelCall,
  type ModelPort,
  type ModelUsage,
  type SelectedModelRoute,
  toErrorInfo,
} from '@galaxie/core';
import type { CallbackManagerForLLMRun, Callbacks } from '@langchain/core/callbacks/manager';
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
  assembleStructuredOutputPipeline,
  createContentParser,
} from '@langchain/core/language_models/structured_output';
import {
  AIMessageChunk,
  type BaseMessage,
  type BaseMessageLike,
  isAIMessage,
  isAIMessageChunk,
  type StandardMessageStructure,
} from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult, type LLMResult } from '@langchain/core/outputs';
import { type Runnable, RunnableLambda } from '@langchain/core/runnables';
import { toJsonSchema, Validator } from '@langchain/core/utils/json_schema';
import type { SerializableSchema } from '@langchain/core/utils/standard_schema';
import type { InteropZodType } from '@langchain/core/utils/types';
import type { LangGraphServices } from './host.js';
import type { LangGraphTraceHandler } from './trace-handler.js';

interface RoutedChatModelCallOptions extends BaseChatModelCallOptions {
  readonly jsonSchema?: Readonly<Record<string, unknown>>;
}

type OutputSchema<Output extends Record<string, unknown>> =
  | SerializableSchema<Output>
  | InteropZodType<Output>
  | Record<string, unknown>;

function plainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

const LEASE = Symbol('galaxie.model.lease');
interface ActiveRun {
  readonly models: ModelPort;
  readonly handler: LangGraphTraceHandler;
}
interface CallState {
  readonly lease: ModelCall;
  readonly provider: BaseChatModel;
  readonly handler: LangGraphTraceHandler;
  settled: boolean;
}
const calls = new WeakMap<object, CallState>();

function failure(code: 'invalid' | 'unavailable' | 'unsupported'): GalaxieError {
  return new GalaxieError(code, toErrorInfo(code).message);
}
function token(options: object): object | undefined {
  const value: unknown = Reflect.get(options, LEASE);
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null) throw failure('invalid');
  return value;
}
function usage(message: BaseMessage): ModelUsage | undefined {
  if (!('usage_metadata' in message)) return undefined;
  const value = message.usage_metadata;
  if (
    typeof value !== 'object' ||
    value === null ||
    !('input_tokens' in value) ||
    !('output_tokens' in value)
  )
    return undefined;
  return { inputTokens: value.input_tokens as number, outputTokens: value.output_tokens as number };
}
function finish(call: CallState, successful: boolean, reported?: ModelUsage): void {
  if (call.settled) return;
  call.settled = true;
  if (successful) call.lease.end(reported);
  else call.lease.fail();
}
function recordFailure(call: CallState, error: unknown): void {
  if (call.lease.credential !== undefined) call.handler.recordCredentialFailure(error);
}

/** Keep provider token output behind the routed model's checks on every LangChain path. */
function filteredManager(
  runManager: CallbackManagerForLLMRun | undefined,
): CallbackManagerForLLMRun | undefined {
  if (runManager === undefined) return undefined;
  return Object.assign(Object.create(runManager), {
    handleLLMNewToken: async () => {},
    handleChatModelStreamEvent: async () => {},
  });
}

type ArgumentChunk = NonNullable<
  AIMessageChunk<StandardMessageStructure>['tool_call_chunks']
>[number];

function rawArgumentChunks(message: BaseMessage): ArgumentChunk[] {
  const raw: unknown = message.additional_kwargs['tool_calls'];
  if (!Array.isArray(raw)) return [];
  const calls: ArgumentChunk[] = [];
  for (const [position, call] of raw.entries()) {
    if (!plainObject(call) || !plainObject(call['function'])) continue;
    const fn = call['function'];
    if (typeof fn['arguments'] !== 'string') continue;
    calls.push({
      ...(typeof fn['name'] === 'string' ? { name: fn['name'] } : {}),
      ...(typeof call['id'] === 'string' ? { id: call['id'] } : {}),
      index: typeof call['index'] === 'number' ? call['index'] : position,
      args: fn['arguments'],
    });
  }
  return calls;
}

function argumentChunks(message: BaseMessage): ArgumentChunk[] {
  if (!isAIMessage(message)) return [];
  const calls: Array<{ name: string | undefined; id: string | undefined; args: string }> = [
    ...(message.tool_calls ?? []).map((call) => ({
      name: call.name,
      id: call.id,
      args: JSON.stringify(call.args) ?? '',
    })),
    ...(message.invalid_tool_calls ?? []).map((call) => ({
      name: call.name,
      id: call.id,
      args: call.args ?? '',
    })),
  ];
  const normalized = [...calls];
  // AIMessageChunk can clear invalid_tool_calls while retaining the raw provider arguments.
  for (const { name, id, args: rawArgs } of rawArgumentChunks(message)) {
    let args = rawArgs ?? '';
    try {
      args = JSON.stringify(JSON.parse(args));
    } catch {}
    if (!normalized.some((known) => known.name === name && known.id === id && known.args === args))
      calls.push({ name, id, args });
  }
  return calls.map(({ name, id, args }, index) => ({
    ...(name === undefined ? {} : { name }),
    ...(id === undefined ? {} : { id }),
    index,
    args,
  }));
}

function outputText(message: BaseMessage): string {
  return [message.text, ...argumentChunks(message).map((call) => call.args)].join('\n');
}
export function selectedRouteFromOptions(options: unknown): SelectedModelRoute | undefined {
  if (typeof options !== 'object' || options === null) return undefined;
  const carrier: unknown = Reflect.get(options, LEASE);
  if (typeof carrier !== 'object' || carrier === null) return undefined;
  const lease = calls.get(carrier)?.lease;
  return lease === undefined
    ? undefined
    : { providerId: lease.providerId, destination: lease.destination };
}

/** One LangChain run around a model selected by the run-bound policy port (ADR-0006). */
export class RoutedChatModel extends BaseChatModel<RoutedChatModelCallOptions> {
  readonly #role: string;
  readonly #providers: LangGraphServices['chatModels'];
  readonly #active: () => ActiveRun | undefined;

  constructor(
    role: string,
    providers: LangGraphServices['chatModels'],
    active: () => ActiveRun | undefined,
  ) {
    super({});
    this.#role = role;
    this.#providers = providers;
    this.#active = active;
  }

  override _llmType(): string {
    return 'galaxie-routed';
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
    if (config?.method !== undefined && config.method !== 'jsonSchema')
      throw failure('unsupported');
    let jsonSchema: Readonly<Record<string, unknown>>;
    let validator: Validator;
    let parser: ReturnType<typeof createContentParser<RunOutput>>;
    try {
      jsonSchema = toJsonSchema(schema as Parameters<typeof toJsonSchema>[0]);
      if (!plainObject(jsonSchema)) throw failure('invalid');
      validator = new Validator(jsonSchema);
      parser = createContentParser<RunOutput>(schema);
    } catch {
      throw failure('invalid');
    }
    const safeParser = RunnableLambda.from<BaseMessage, RunOutput>(async (message) => {
      try {
        if (
          typeof message.content !== 'string' ||
          !validator.validate(JSON.parse(message.content)).valid
        )
          throw failure('invalid');
        // Parse directly so content-bearing parser errors never reach callbacks.
        return await parser.parseResult([{ text: message.content }]);
      } catch {
        throw failure('invalid');
      }
    });
    return assembleStructuredOutputPipeline(
      this.withConfig({ jsonSchema }),
      safeParser,
      config?.includeRaw,
    );
  }

  async #begin(options: Partial<BaseChatModelCallOptions> | undefined): Promise<CallState> {
    const run = this.#active();
    if (run === undefined) throw failure('invalid');
    const jsonSchema: unknown =
      options === undefined ? undefined : Reflect.get(options, 'jsonSchema');
    const structured = plainObject(jsonSchema);
    const lease = await run.models.begin(
      this.#role,
      options?.signal === undefined && !structured
        ? undefined
        : {
            ...(options?.signal === undefined ? {} : { signal: options.signal }),
            ...(structured ? { requires: ['structured-output'] as const } : {}),
          },
    );
    try {
      const implementation = Object.hasOwn(this.#providers, lease.providerId)
        ? this.#providers[lease.providerId]
        : undefined;
      if (implementation === undefined) throw failure('unavailable');
      if (typeof implementation === 'function' && lease.credential === undefined)
        throw failure('invalid');
      const provider =
        typeof implementation === 'function'
          ? implementation({ credential: lease.credential as string })
          : implementation;
      return { lease, provider, handler: run.handler, settled: false };
    } catch (error) {
      if (lease.credential !== undefined) run.handler.recordCredentialFailure(error);
      lease.fail();
      throw error;
    }
  }

  async #take(options: this['ParsedCallOptions']): Promise<CallState> {
    const carrier = token(options);
    if (carrier === undefined) return this.#begin(options);
    const call = calls.get(carrier);
    if (call === undefined) throw failure('invalid');
    calls.delete(carrier);
    return call;
  }

  override getLsParams(options: this['ParsedCallOptions']): LangSmithParams {
    const carrier = token(options);
    if (carrier === undefined) return super.getLsParams(options);
    const call = calls.get(carrier);
    if (call === undefined) throw failure('invalid');
    return call.provider.getLsParams(options);
  }

  override async generate(
    messages: BaseMessageLike[][],
    options?: string[] | Partial<BaseChatModelCallOptions>,
    callbacks?: Callbacks,
  ): Promise<LLMResult> {
    if (messages.length > 1) throw failure('unsupported');
    const parsed = Array.isArray(options) ? { stop: options } : options;
    const call = await this.#begin(parsed);
    const carrier = Object.freeze({});
    calls.set(carrier, call);
    const leasedOptions = { ...parsed, [LEASE]: carrier };
    try {
      const result = await super.generate(messages, leasedOptions, callbacks);
      return result;
    } catch (error) {
      recordFailure(call, error);
      throw error;
    } finally {
      calls.delete(carrier);
      finish(call, false);
    }
  }

  override async *_streamIterator(
    input: BaseLanguageModelInput,
    options?: Partial<BaseChatModelCallOptions>,
  ): AsyncGenerator<AIMessageChunk> {
    if (this.disableStreaming) {
      yield await this.invoke(input, options);
      return;
    }
    const call = await this.#begin(options);
    const carrier = Object.freeze({});
    calls.set(carrier, call);
    const leasedOptions = { ...options, [LEASE]: carrier };
    try {
      yield* super._streamIterator(input, leasedOptions);
    } catch (error) {
      recordFailure(call, error);
      throw error;
    } finally {
      calls.delete(carrier);
      finish(call, false);
    }
  }

  override async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const call = await this.#take(options);
    try {
      if (runManager !== undefined) call.handler.setModelRoute(runManager.runId, call.lease);
      const result = await call.provider._generate(messages, options, filteredManager(runManager));
      await call.lease.checkOutput(
        result.generations.map((generation) => outputText(generation.message)).join('\n'),
        { final: true },
      );
      finish(
        call,
        true,
        result.generations[0] === undefined ? undefined : usage(result.generations[0].message),
      );
      return result;
    } catch (error) {
      recordFailure(call, error);
      throw error;
    } finally {
      if (runManager !== undefined)
        call.handler.setOutputSafetyOutcome(runManager.runId, call.lease.outputSafetyOutcome);
      finish(call, false);
    }
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const call = await this.#take(options);
    try {
      if (runManager !== undefined) call.handler.setModelRoute(runManager.runId, call.lease);
      let reported: ModelUsage | undefined;
      let text = '';
      let checked = '';
      const argumentsText: string[] = [];
      const fragmentSlots = new Map<string, number>();
      const providerManager = filteredManager(runManager);
      const chunks =
        call.provider.disableStreaming === true ||
        call.provider._streamResponseChunks === BaseChatModel.prototype._streamResponseChunks
          ? this.#generateChunk(call.provider, messages, options, providerManager)
          : call.provider._streamResponseChunks(messages, options, providerManager);
      for await (const chunk of chunks) {
        text += chunk.text;
        const fragments = isAIMessageChunk(chunk.message)
          ? chunk.message.tool_call_chunks
          : undefined;
        if (fragments !== undefined && fragments.length > 0) {
          for (const [position, fragment] of fragments.entries()) {
            const key = JSON.stringify(
              fragment.index !== undefined
                ? ['index', fragment.index]
                : fragment.id !== undefined
                  ? ['id', fragment.id]
                  : ['position', position],
            );
            let slot = fragmentSlots.get(key);
            if (slot === undefined) {
              slot = argumentsText.length;
              fragmentSlots.set(key, slot);
              argumentsText.push('');
            }
            argumentsText[slot] = (argumentsText[slot] ?? '') + (fragment.args ?? '');
          }
          for (const raw of rawArgumentChunks(chunk.message)) {
            const mirrored = fragments.some(
              (fragment, position) =>
                fragment.args === raw.args &&
                (fragment.name === undefined ||
                  raw.name === undefined ||
                  fragment.name === raw.name) &&
                (fragment.id !== undefined && raw.id !== undefined
                  ? fragment.id === raw.id
                  : (fragment.index ?? position) === raw.index),
            );
            if (!mirrored) argumentsText.push(raw.args ?? '');
          }
        } else {
          argumentsText.push(...argumentChunks(chunk.message).map((call) => call.args ?? ''));
        }
        // Preserve original arguments: native concat can drop complete calls beside fragments.
        const next = [text, ...argumentsText.filter((value) => value.length > 0)].join('\n');
        if (next !== checked) {
          await call.lease.checkOutput(next, { final: false });
          checked = next;
        }
        const current = usage(chunk.message);
        if (current !== undefined)
          reported = {
            inputTokens: (reported?.inputTokens ?? 0) + current.inputTokens,
            outputTokens: (reported?.outputTokens ?? 0) + current.outputTokens,
          };
        yield chunk;
        await runManager?.handleLLMNewToken(
          chunk.text,
          undefined,
          undefined,
          undefined,
          undefined,
          { chunk },
        );
      }
      await call.lease.checkOutput(checked, { final: true });
      finish(call, true, reported);
    } catch (error) {
      recordFailure(call, error);
      throw error;
    } finally {
      if (runManager !== undefined)
        call.handler.setOutputSafetyOutcome(runManager.runId, call.lease.outputSafetyOutcome);
      finish(call, false);
    }
  }

  async *#generateChunk(
    provider: BaseChatModel,
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const result = await provider._generate(messages, options, runManager);
    const generation = result.generations[0];
    if (generation === undefined) return;
    const chunk = new ChatGenerationChunk({
      text: generation.text,
      message: new AIMessageChunk<StandardMessageStructure>({
        ...generation.message,
        tool_call_chunks: argumentChunks(generation.message),
      }),
      ...(generation.generationInfo === undefined
        ? {}
        : { generationInfo: generation.generationInfo }),
    });
    yield chunk;
    await runManager?.handleLLMNewToken(chunk.text, undefined, undefined, undefined, undefined, {
      chunk,
    });
  }
}
