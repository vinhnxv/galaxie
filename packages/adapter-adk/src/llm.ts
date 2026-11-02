// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { ModelCall, ModelFeature } from '@galaxie/core';
import { BaseLlm, type LlmRequest, type LlmResponse } from '@google/adk';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { failure } from './errors.js';
import type { RunState } from './run.js';
import { declarationParameters, responseJsonSchema } from './schema.js';
import { checkedText } from './tool-calls.js';

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

function usageOf(reply: AIMessage): { input: number; output: number } | undefined {
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
 * routing, labels, consent, budgets and output checks stay in galaxie. Non-streaming only.
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
      yield await this.#generate(run, request, stream === true, abortSignal);
    } catch (error) {
      throw run.fail(error);
    }
  }

  override async connect(): Promise<never> {
    throw failure('unsupported');
  }

  async #generate(
    run: RunState,
    request: LlmRequest,
    stream: boolean,
    abortSignal: AbortSignal | undefined,
  ): Promise<LlmResponse> {
    // After a fatal error nothing more may reach a provider or the model.
    if (run.failure !== undefined) throw run.failure;
    if (stream) throw failure('unsupported');
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
      const reply = await this.#invoke(lease, signal, messages, tools, jsonSchema, request);
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
      return {
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
    } catch (error) {
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
      throw error;
    }
  }

  async #invoke(
    lease: ModelCall,
    signal: AbortSignal,
    messages: BaseMessage[],
    tools: readonly OpenAiTool[],
    jsonSchema: Record<string, unknown> | undefined,
    request: LlmRequest,
  ): Promise<AIMessage> {
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
    if (tools.length > 0 && typeof provider.bindTools !== 'function') throw failure('unsupported');
    const bound = tools.length > 0 ? provider.bindTools?.([...tools]) : provider;
    if (bound === undefined) throw failure('unsupported');
    const stop = request.config?.stopSequences;
    const options = {
      signal,
      ...(stop === undefined || stop.length === 0 ? {} : { stop: [...stop] }),
      ...(jsonSchema === undefined ? {} : { jsonSchema }),
      [DESTINATION]: lease.destination,
    };
    return bound.invoke(messages, options);
  }
}
