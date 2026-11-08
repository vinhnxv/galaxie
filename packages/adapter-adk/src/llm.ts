// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { resolveProvider, sameJson } from '@galaxie-ai/adapter-kit';
import type { ModelCall, ModelFeature } from '@galaxie-ai/core';
import { BaseLlm, type LlmRequest, type LlmResponse } from '@google/adk';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  AIMessage,
  type AIMessageChunk,
  type BaseMessage,
  HumanMessage,
  isAIMessageChunk,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { concat } from '@langchain/core/utils/stream';
import { failure } from './errors.js';
import type { RunState } from './run.js';
import { declarationParameters, responseJsonSchema } from './schema.js';
import { checkedText, outputText } from './tool-calls.js';

/** Credential providers are constructed per call; credentials never enter call options (ADR-0006). */
export type AdkChatModel =
  | BaseChatModel
  | ((options: { readonly credential: string }) => BaseChatModel);

type Content = LlmRequest['contents'][number];
type Part = NonNullable<Content['parts']>[number];
type OpenAiTool = {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
};

const DESTINATION = Symbol.for('galaxie.model.destination');
/** In-process tools ADK adds to a request itself; none of them reaches the network. */
const INTERNAL_TOOLS: ReadonlySet<string> = new Set([
  'transfer_to_agent',
  'set_model_response',
  'finish_task',
]);

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function partText(part: Part): string {
  const known = Object.keys(part).filter((key) => part[key as keyof Part] !== undefined);
  if (known.some((key) => key !== 'text' && key !== 'thought' && key !== 'thoughtSignature'))
    throw failure('unsupported');
  return part.thought === true || part.text === undefined ? '' : part.text;
}

function instructionText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(instructionText).join('\n');
  if (object(value) && Array.isArray(value['parts']))
    return value['parts'].map(instructionText).join('\n');
  if (object(value) && typeof value['text'] === 'string' && Object.keys(value).length === 1)
    return value['text'];
  throw failure('unsupported');
}

/** ADK turns to chat messages in OpenAI order: system, then user, assistant and tool messages. */
export function chatMessages(request: LlmRequest): BaseMessage[] {
  const messages: BaseMessage[] = [];
  const system = request.config?.systemInstruction;
  if (system !== undefined) {
    const text = instructionText(system);
    if (text.length > 0) messages.push(new SystemMessage(text));
  }
  for (const content of request.contents) {
    const parts = content.parts ?? [];
    if (content.role === 'model') {
      const calls: {
        id: string;
        name: string;
        args: Record<string, unknown>;
        type: 'tool_call';
      }[] = [];
      let text = '';
      for (const part of parts) {
        if (part.functionCall !== undefined) {
          const { id, name, args } = part.functionCall;
          if (typeof id !== 'string' || id.length === 0 || typeof name !== 'string')
            throw failure('invalid');
          calls.push({ id, name, args: args ?? {}, type: 'tool_call' });
        } else text += partText(part);
      }
      messages.push(new AIMessage({ content: text, tool_calls: calls }));
      continue;
    }
    let text = '';
    for (const part of parts) {
      if (part.functionResponse !== undefined) {
        const { id, name, response } = part.functionResponse;
        if (typeof id !== 'string' || id.length === 0) throw failure('invalid');
        messages.push(
          new ToolMessage({
            content: JSON.stringify(response ?? {}),
            tool_call_id: id,
            ...(name === undefined ? {} : { name }),
          }),
        );
      } else text += partText(part);
    }
    if (text.length > 0) messages.push(new HumanMessage(text));
  }
  return messages;
}

/** Gemini-style function declarations as OpenAI-format tools. */
export function openAiTools(request: LlmRequest): OpenAiTool[] {
  const tools: OpenAiTool[] = [];
  for (const tool of request.config?.tools ?? []) {
    if (!object(tool)) throw failure('invalid');
    const declarations = tool['functionDeclarations'];
    if (
      !Array.isArray(declarations) ||
      Object.keys(tool).some((key) => key !== 'functionDeclarations')
    )
      throw failure('unsupported');
    for (const declaration of declarations) {
      if (!object(declaration) || typeof declaration['name'] !== 'string') throw failure('invalid');
      if (tools.some((known) => known.function.name === declaration['name']))
        throw failure('invalid');
      tools.push({
        type: 'function',
        function: {
          name: declaration['name'],
          description:
            typeof declaration['description'] === 'string' ? declaration['description'] : '',
          parameters: declarationParameters(declaration),
        },
      });
    }
  }
  return tools;
}

function usageOf(reply: AIMessage | AIMessageChunk): { input: number; output: number } | undefined {
  const reported: unknown = Reflect.get(reply, 'usage_metadata');
  if (reported === undefined) return undefined;
  if (!object(reported)) throw failure('invalid');
  const input = reported['input_tokens'];
  const output = reported['output_tokens'];
  if (typeof input !== 'number' || typeof output !== 'number') return undefined;
  return { input, output };
}

/**
 * The router-backed ADK model (KTD3). Every call is leased through the run's `ModelPort`, so
 * routing, labels, consent, budgets and output checks stay in galaxie. With `stream` set, each text
 * delta is checked before ADK receives it and the final response carries the whole reply (KTD10).
 */
export class GalaxieLlm extends BaseLlm {
  readonly #role: string;
  readonly #providers: Readonly<Record<string, AdkChatModel>>;
  readonly #active: () => RunState | undefined;
  readonly #trusted: (tool: unknown) => boolean;

  constructor(init: {
    readonly role: string;
    readonly providers: Readonly<Record<string, AdkChatModel>>;
    readonly active: () => RunState | undefined;
    readonly trusted: (tool: unknown) => boolean;
  }) {
    super({ model: `galaxie:${init.role}` });
    this.#role = init.role;
    this.#providers = init.providers;
    this.#active = init.active;
    this.#trusted = init.trusted;
  }

  override async *generateContentAsync(
    request: LlmRequest,
    stream?: boolean,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    const run = this.#active();
    if (run === undefined) throw failure('invalid');
    try {
      yield* this.#generate(run, request, stream === true, abortSignal);
    } catch (error) {
      throw run.fail(error);
    }
  }

  override async connect(): Promise<never> {
    throw failure('unsupported');
  }

  async *#generate(
    run: RunState,
    request: LlmRequest,
    stream: boolean,
    abortSignal: AbortSignal | undefined,
  ): AsyncGenerator<LlmResponse, void> {
    // After a fatal error nothing more may reach a provider or the model.
    if (run.failure !== undefined) throw run.failure;
    for (const [name, tool] of Object.entries(request.toolsDict))
      if (!this.#trusted(tool) && !INTERNAL_TOOLS.has(name)) throw failure('unsupported');
    run.countModelCall();
    const messages = chatMessages(request);
    const tools = openAiTools(request);
    const offered = new Set(tools.map((tool) => tool.function.name));
    const jsonSchema =
      request.config === undefined ? undefined : responseJsonSchema(request.config);
    const requires: ModelFeature[] = [
      ...(tools.length > 0 ? (['tool-calling'] as const) : []),
      ...(jsonSchema === undefined ? [] : (['structured-output'] as const)),
    ];
    const signal =
      abortSignal === undefined ? run.signal : AbortSignal.any([run.signal, abortSignal]);
    const lease = await run.models.begin(this.#role, {
      signal,
      ...(requires.length > 0 ? { requires } : {}),
    });
    const route = { providerId: lease.providerId, destination: lease.destination };
    const span = run.trace.start({ kind: 'model', route }, run.span);
    let settled = false;
    try {
      const reply: AIMessage | AIMessageChunk = stream
        ? yield* this.#stream(lease, signal, messages, tools, jsonSchema, request)
        : await this.#invoke(lease, signal, messages, tools, jsonSchema, request);
      const calls = reply.tool_calls ?? [];
      if (
        typeof reply.content !== 'string' ||
        (tools.length === 0 &&
          (calls.length > 0 ||
            (reply.invalid_tool_calls?.length ?? 0) > 0 ||
            reply.additional_kwargs['tool_calls'] !== undefined))
      )
        throw failure('unsupported');
      if ((reply.invalid_tool_calls?.length ?? 0) > 0) throw failure('invalid');
      if (calls.some((call) => !offered.has(call.name))) throw failure('invalid');
      await lease.checkOutput(checkedText(reply), { final: true });
      if (signal.aborted) throw failure('cancelled');
      const usage = usageOf(reply);
      lease.end(
        usage === undefined ? undefined : { inputTokens: usage.input, outputTokens: usage.output },
      );
      settled = true;
      span.end({
        status: 'ok',
        ...(usage === undefined
          ? {}
          : { usage: { inputTokens: usage.input, outputTokens: usage.output } }),
        ...(lease.outputSafetyOutcome === undefined
          ? {}
          : { outputSafetyOutcome: lease.outputSafetyOutcome }),
        route,
      });
      // Provider call IDs are discarded; the run assigns IDs after those already in the session.
      const parts: Part[] = [
        ...(reply.content.length > 0 ? [{ text: reply.content }] : []),
        ...calls.map((call) => ({
          functionCall: { id: run.takeCallId(), name: call.name, args: call.args },
        })),
      ];
      yield {
        content: { role: 'model', parts: parts.length > 0 ? parts : [{ text: '' }] },
        turnComplete: true,
        ...(usage === undefined
          ? {}
          : {
              usageMetadata: {
                promptTokenCount: usage.input,
                candidatesTokenCount: usage.output,
                totalTokenCount: usage.input + usage.output,
              },
            }),
      };
    } finally {
      // Also reached when ADK stops consuming mid-stream; a lease is settled exactly once.
      if (!settled) {
        lease.fail();
        settled = true;
        span.end({
          status: 'error',
          errorType: 'GalaxieError',
          ...(lease.outputSafetyOutcome === undefined
            ? {}
            : { outputSafetyOutcome: lease.outputSafetyOutcome }),
          route,
        });
      }
    }
  }

  #bind(
    lease: ModelCall,
    signal: AbortSignal,
    tools: readonly OpenAiTool[],
    jsonSchema: Record<string, unknown> | undefined,
    request: LlmRequest,
  ) {
    const provider = resolveProvider(this.#providers, lease);
    if (tools.length > 0 && typeof provider.bindTools !== 'function') throw failure('unsupported');
    const bound = tools.length > 0 ? provider.bindTools?.([...tools]) : provider;
    if (bound === undefined) throw failure('unsupported');
    const stop = request.config?.stopSequences;
    // Only a positive integer from the caller can lower the route's limit; anything else is ignored.
    const requested = request.config?.maxOutputTokens;
    const options = {
      signal,
      maxTokens:
        requested !== undefined && Number.isSafeInteger(requested) && requested > 0
          ? Math.min(requested, lease.maxTokens)
          : lease.maxTokens,
      ...(stop === undefined || stop.length === 0 ? {} : { stop: [...stop] }),
      ...(jsonSchema === undefined ? {} : { jsonSchema }),
      [DESTINATION]: lease.destination,
    };
    return { bound, options };
  }

  async #invoke(
    lease: ModelCall,
    signal: AbortSignal,
    messages: BaseMessage[],
    tools: readonly OpenAiTool[],
    jsonSchema: Record<string, unknown> | undefined,
    request: LlmRequest,
  ): Promise<AIMessage> {
    const { bound, options } = this.#bind(lease, signal, tools, jsonSchema, request);
    return bound.invoke(messages, options);
  }

  /**
   * Yields one partial response per provider chunk that carries text, after the growing reply
   * (text and call arguments) passed the output check, and returns the joined reply. A provider
   * without native streaming yields its whole reply as one chunk.
   */
  async *#stream(
    lease: ModelCall,
    signal: AbortSignal,
    messages: BaseMessage[],
    tools: readonly OpenAiTool[],
    jsonSchema: Record<string, unknown> | undefined,
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, AIMessage | AIMessageChunk> {
    const { bound, options } = this.#bind(lease, signal, tools, jsonSchema, request);
    let joined: AIMessage | AIMessageChunk | undefined;
    let checked = '';
    const fragments = new Map<string, number>();
    const raw: string[] = [];
    let complete = 0;
    for await (const chunk of await bound.stream(messages, options)) {
      // Native concat repairs cut-off argument JSON and can drop complete calls beside fragments,
      // so the raw fragments are tracked here and the joined calls are verified against them.
      const pieces = isAIMessageChunk(chunk) ? (chunk.tool_call_chunks ?? []) : [];
      // A fragment alone is rarely valid JSON, so only a provider-reported invalid call counts here.
      if (pieces.length === 0 && (chunk.invalid_tool_calls?.length ?? 0) > 0)
        throw failure('invalid');
      if (pieces.length === 0 && (chunk.tool_calls?.length ?? 0) > 0) complete += 1;
      for (const [position, piece] of pieces.entries()) {
        const key = JSON.stringify(
          piece.index !== undefined
            ? ['index', piece.index]
            : piece.id !== undefined
              ? ['id', piece.id]
              : ['position', position],
        );
        let slot = fragments.get(key);
        if (slot === undefined) {
          slot = raw.length;
          fragments.set(key, slot);
          raw.push('');
        }
        raw[slot] = (raw[slot] ?? '') + (piece.args ?? '');
      }
      joined = joined === undefined ? chunk : concat(joined, chunk);
      const next = outputText(joined);
      if (next !== checked) {
        await lease.checkOutput(next, { final: false });
        checked = next;
      }
      if (signal.aborted) throw failure('cancelled');
      const delta = chunk.text;
      if (delta.length > 0)
        yield { content: { role: 'model', parts: [{ text: delta }] }, partial: true };
    }
    if (joined === undefined) throw failure('unavailable');
    if (complete > 0 && (raw.length > 0 || complete > 1)) throw failure('unsupported');
    if (raw.length > 0) {
      const calls = joined.tool_calls ?? [];
      if (calls.length !== raw.length) throw failure('invalid');
      for (const [slot, text] of raw.entries())
        if (!sameJson(text === '' ? '{}' : text, calls[slot]?.args)) throw failure('invalid');
    }
    return joined;
  }
}
