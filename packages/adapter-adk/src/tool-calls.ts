// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import {
  type AIMessageChunk,
  type BaseMessage,
  isAIMessage,
  type StandardMessageStructure,
} from '@langchain/core/messages';

/** One model-originated tool call as the output check sees it. */
export interface ReplyCall {
  readonly id: string | undefined;
  readonly name: string | undefined;
  readonly args: string;
}

type ArgumentChunk = NonNullable<
  AIMessageChunk<StandardMessageStructure>['tool_call_chunks']
>[number];

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rawArgumentChunks(message: BaseMessage): ArgumentChunk[] {
  const raw: unknown = message.additional_kwargs['tool_calls'];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((call, position) => {
    if (!object(call) || !object(call['function'])) return [];
    const fn = call['function'];
    if (typeof fn['arguments'] !== 'string') return [];
    return [
      {
        ...(typeof fn['name'] === 'string' ? { name: fn['name'] } : {}),
        ...(typeof call['id'] === 'string' ? { id: call['id'] } : {}),
        index: typeof call['index'] === 'number' ? call['index'] : position,
        args: fn['arguments'],
      },
    ];
  });
}

/**
 * Every call the provider reported: normalized, invalid and raw mirrors. A raw call that repeats a
 * normalized one is dropped, so the checked text matches the routed LangChain model's.
 */
export function replyCalls(message: BaseMessage): ReplyCall[] {
  if (!isAIMessage(message)) return [];
  const calls: ReplyCall[] = [
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
  for (const { name, id, args: rawArgs } of rawArgumentChunks(message)) {
    let args = rawArgs ?? '';
    try {
      args = JSON.stringify(JSON.parse(args));
    } catch {}
    if (!normalized.some((known) => known.name === name && known.id === id && known.args === args))
      calls.push({ name, id, args });
  }
  return calls;
}

/** Reply text plus each call's argument string, joined by newlines (the shared case table). */
export function outputText(message: BaseMessage): string {
  return [message.text, ...replyCalls(message).map((call) => call.args)].join('\n');
}

/**
 * What the output-safety hook receives for a complete reply: `outputText` plus every call ID and
 * name, because ADK acts on those strings too.
 */
export function checkedText(message: BaseMessage): string {
  return [outputText(message), ...replyCalls(message).flatMap((call) => [call.id, call.name])]
    .filter((value): value is string => value !== undefined)
    .join('\n');
}
