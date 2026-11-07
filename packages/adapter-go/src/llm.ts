// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { resolveProvider } from '@galaxie/adapter-kit';
import type { ModelCall, ModelPreparation, ModelUsage, RunRequest } from '@galaxie/core';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  AIMessage,
  type AIMessageChunk,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import {
  type BridgeToolCall,
  encodeReply,
  type ModelReply,
  parseCapabilityPayload,
  parseModelPayload,
} from './bridge.js';
import { validCheckpointPort } from './checkpoints.js';
import { adapterFailure } from './errors.js';
import { isRecord } from './protocol.js';
import {
  carriesCalls,
  DeltaSplitter,
  emitDelta,
  emitMarker,
  StreamJoiner,
  type StreamSink,
} from './stream.js';
import { growingText } from './tool-calls.js';

export type GoChatModel =
  | BaseChatModel
  | ((options: { readonly credential: string }) => BaseChatModel);

/** The models the host provides; the Go program names a role and never a provider. */
export interface GoServices {
  readonly chatModels: Readonly<Record<string, GoChatModel>>;
  /**
   * The byte-record checkpoint port of `@galaxie/storage-indexeddb`. With it, each pause and each
   * completed conversation is stored so that a reload or a lost Worker does not lose it; without
   * it, a paused session lives in the Worker only.
   */
  readonly checkpoints?: { request(value: unknown): Promise<unknown> };
}

export interface LeasedCall {
  readonly lease: ModelCall;
  settled: boolean;
}

/** The run the Worker is serving; every bridge call is checked against it. */
export interface ActiveRun extends StreamSink {
  readonly id: string;
  readonly request: RunRequest;
  readonly seen: Set<string>;
  readonly leases: Set<LeasedCall>;
  /** Whether the host asked this run for stream events. */
  readonly streaming: boolean;
  modelCalls: number;
}

export function validServices(
  services: unknown,
  models?: ModelPreparation,
): services is GoServices {
  if (!isRecord(services) || !isRecord(services['chatModels'])) return false;
  if (
    Object.hasOwn(services, 'checkpoints') &&
    services['checkpoints'] !== undefined &&
    !validCheckpointPort(services['checkpoints'])
  )
    return false;
  const implementations = services['chatModels'];
  if (
    !Object.values(implementations).every(
      (model) =>
        typeof model === 'function' || (isRecord(model) && typeof model['invoke'] === 'function'),
    )
  )
    return false;
  return Object.entries(models?.providers ?? {}).every(([id, descriptor]) => {
    const provider = Object.hasOwn(implementations, id) ? implementations[id] : undefined;
    return provider !== undefined && (typeof provider === 'function') === descriptor.credential;
  });
}

/** Settles a lease exactly once: usage on success, a failure mark otherwise. */
export function finish(
  run: ActiveRun,
  call: LeasedCall,
  usage?: ModelUsage,
  succeeded = false,
): void {
  if (call.settled) return;
  call.settled = true;
  run.leases.delete(call);
  if (succeeded) call.lease.end(usage);
  else call.lease.fail();
}

function aborted(run: ActiveRun): boolean {
  return run.cancelled || run.request.signal.aborted;
}

function callsOf(reply: AIMessage, offered: ReadonlySet<string>): BridgeToolCall[] {
  if (
    reply.invalid_tool_calls?.length ||
    (offered.size === 0 && reply.additional_kwargs['tool_calls'] !== undefined)
  )
    throw adapterFailure('invalid');
  return (reply.tool_calls ?? []).map((call) => {
    if (typeof call.id !== 'string' || call.id.length === 0 || call.id.length > 128)
      throw adapterFailure('invalid');
    if (!offered.has(call.name)) throw adapterFailure('invalid');
    return {
      id: call.id,
      type: 'function' as const,
      function: { name: call.name, arguments: JSON.stringify(call.args) },
    };
  });
}

function usageOf(reply: AIMessage): ModelReply['usage'] {
  const reported: unknown = Reflect.get(reply, 'usage_metadata');
  if (reported === undefined) return undefined;
  if (!isRecord(reported)) throw adapterFailure('invalid');
  const input = reported['input_tokens'];
  const output = reported['output_tokens'];
  const total = reported['total_tokens'];
  if (
    !Number.isSafeInteger(input) ||
    !Number.isSafeInteger(output) ||
    !Number.isSafeInteger(total) ||
    (input as number) < 0 ||
    (output as number) < 0 ||
    total !== (input as number) + (output as number)
  )
    throw adapterFailure('invalid');
  return {
    input_tokens: input as number,
    output_tokens: output as number,
    total_tokens: total as number,
  };
}

/**
 * Reads a provider's reply as it grows. Every chunk's text and call arguments pass the output
 * check before its text reaches the host as a `messages` event, so a blocked chunk is never
 * forwarded; Go still receives only the finished reply, checked once more by the caller.
 */
async function streamReply(
  run: ActiveRun,
  lease: ModelCall,
  bound: Pick<BaseChatModel, 'stream'>,
  messages: BaseMessage[],
  options: Parameters<BaseChatModel['stream']>[1],
  author: string,
  offered: boolean,
): Promise<AIMessage | AIMessageChunk> {
  const joiner = new StreamJoiner();
  const splitter = new DeltaSplitter();
  for await (const chunk of await bound.stream(messages, options)) {
    if (aborted(run)) throw adapterFailure('cancelled');
    if (typeof chunk.content !== 'string' || (!offered && carriesCalls(chunk)))
      throw adapterFailure('unsupported');
    await lease.checkOutput(growingText(joiner.append(chunk)), { final: false });
    if (aborted(run)) throw adapterFailure('cancelled');
    for (const piece of splitter.feed(chunk.content)) emitDelta(run, author, piece);
  }
  return joiner.finish();
}

/** Serves one model request from Go through the run's router lease; the reply is bridge text. */
export async function serveModel(
  run: ActiveRun,
  services: GoServices,
  text: string,
): Promise<string> {
  const input = parseModelPayload(text);
  // Go asks for a stream only when the host did; anything else is a program the page did not start.
  if (input.options.stream && !run.streaming) throw adapterFailure('invalid');
  if (run.modelCalls++ >= run.request.limits.steps) throw adapterFailure('budget_exceeded');
  const offered = new Set((input.options.tools ?? []).map((tool) => tool.function.name));
  const requires = [
    ...(offered.size > 0 ? ['tool-calling' as const] : []),
    ...(input.options.jsonSchema === undefined ? [] : ['structured-output' as const]),
  ];
  const lease = await run.request.models.begin(input.role, {
    signal: run.request.signal,
    ...(requires.length ? { requires } : {}),
  });
  const call: LeasedCall = { lease, settled: false };
  run.leases.add(call);
  try {
    if (aborted(run)) throw adapterFailure('cancelled');
    const provider = resolveProvider(services.chatModels, lease);
    const bound =
      offered.size > 0 ? provider.bindTools?.([...(input.options.tools ?? [])]) : provider;
    if (!bound) throw adapterFailure('unsupported');
    const messages = input.messages.map((item) => {
      switch (item.role) {
        case 'system':
          return new SystemMessage(item.content);
        case 'user':
          return new HumanMessage(item.content);
        case 'tool':
          return new ToolMessage({
            content: item.content,
            tool_call_id: item.tool_call_id as string,
          });
        case 'assistant':
          return new AIMessage({
            content: item.content,
            tool_calls: (item.toolCalls ?? []).map((toolCall) => {
              let args: unknown;
              try {
                args = JSON.parse(toolCall.function.arguments);
              } catch {
                throw adapterFailure('invalid');
              }
              if (!isRecord(args)) throw adapterFailure('invalid');
              return { id: toolCall.id, name: toolCall.function.name, args };
            }),
          });
        default:
          throw adapterFailure('invalid');
      }
    });
    const callOptions = {
      signal: run.request.signal,
      ...(input.options.stop === undefined ? {} : { stop: [...input.options.stop] }),
      ...(input.options.jsonSchema === undefined ? {} : { jsonSchema: input.options.jsonSchema }),
      [Symbol.for('galaxie.model.destination')]: lease.destination,
    };
    // The parser pairs an author with `stream: true`, so the author alone selects the streamed path.
    const reply =
      input.author !== undefined
        ? await streamReply(
            run,
            lease,
            bound,
            messages,
            callOptions,
            input.author,
            offered.size > 0,
          )
        : await bound.invoke(messages, callOptions);
    if (typeof reply.content !== 'string') throw adapterFailure('unsupported');
    const calls = callsOf(reply, offered);
    if (offered.size === 0 && (reply.tool_calls?.length ?? 0) > 0)
      throw adapterFailure('unsupported');
    // Call arguments, IDs and names are model text that Go receives, so they are checked too. A
    // provider that mirrors its raw calls into additional_kwargs has them checked as well.
    const raw: unknown = reply.additional_kwargs['tool_calls'];
    const checked = [
      reply.content,
      ...(raw === undefined ? [] : [JSON.stringify(raw)]),
      ...calls.map((item) => item.function.arguments),
      ...calls.map((item) => item.id),
      ...calls.map((item) => item.function.name),
    ].join('\n');
    await lease.checkOutput(checked, { final: true });
    if (aborted(run)) throw adapterFailure('cancelled');
    const usage = usageOf(reply);
    const result: ModelReply = {
      content: reply.content,
      ...(calls.length ? { toolCalls: calls } : {}),
      ...(usage === undefined ? {} : { usage }),
    };
    const encoded = encodeReply(result);
    if (run.streaming) for (const item of calls) emitMarker(run, 'tool_call', item.function.name);
    finish(
      run,
      call,
      usage === undefined
        ? undefined
        : { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens },
      true,
    );
    return encoded;
  } finally {
    finish(run, call);
  }
}

/** Serves one capability call from Go through the broker; the reply is bridge text. */
export async function serveCapability(run: ActiveRun, text: string): Promise<string> {
  const input = parseCapabilityPayload(text);
  const result = await run.request.capabilities.call(input.name, input.input, {
    signal: run.request.signal,
    ...(input.effectScope === undefined ? {} : { effectScope: input.effectScope }),
  });
  if (aborted(run)) throw adapterFailure('cancelled');
  const encoded = encodeReply(result === undefined ? null : result);
  if (run.streaming) emitMarker(run, 'tool_result', input.name);
  return encoded;
}
