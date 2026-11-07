// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type {
  AIMessage,
  AIMessageChunk,
  BaseMessage,
  StandardMessageStructure,
} from '@langchain/core/messages';
import { isPlainObject } from './validation.js';

export interface ReplyCall {
  readonly id: string | undefined;
  readonly name: string | undefined;
  readonly args: string;
}

export type ArgumentChunk = NonNullable<
  AIMessageChunk<StandardMessageStructure>['tool_call_chunks']
>[number];

/** Adapters retain their existing raw-object acceptance rule. */
export function rawArgumentChunks(
  message: BaseMessage,
  object: (value: unknown) => value is Record<string, unknown> = isPlainObject,
): ArgumentChunk[] {
  const raw: unknown = message.additional_kwargs['tool_calls'];
  if (!Array.isArray(raw)) return [];
  const calls: ArgumentChunk[] = [];
  for (const [position, call] of raw.entries()) {
    if (!object(call) || !object(call['function'])) continue;
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

/** Whether a native fragment already carries this raw argument string. */
export function hasArgumentMirror(
  raw: ArgumentChunk,
  fragments: readonly ArgumentChunk[],
): boolean {
  return fragments.some(
    (fragment, position) =>
      fragment.args === raw.args &&
      (fragment.name === undefined || raw.name === undefined || fragment.name === raw.name) &&
      (fragment.id !== undefined && raw.id !== undefined
        ? fragment.id === raw.id
        : (fragment.index ?? position) === raw.index),
  );
}

/** The adapter supplies its framework's AI-message predicate; the kit loads no runtime. */
export function replyCalls(
  message: BaseMessage,
  aiMessage: boolean,
  includeRaw = true,
  object: (value: unknown) => value is Record<string, unknown> = isPlainObject,
): ReplyCall[] {
  if (!aiMessage) return [];
  const ai = message as AIMessage<StandardMessageStructure>;
  const calls: ReplyCall[] = [
    ...(ai.tool_calls ?? []).map((call) => ({
      name: call.name,
      id: call.id,
      args: JSON.stringify(call.args) ?? '',
    })),
    ...(ai.invalid_tool_calls ?? []).map((call) => ({
      name: call.name,
      id: call.id,
      args: call.args ?? '',
    })),
  ];
  const normalized = [...calls];
  // Native concatenation can clear invalid calls while retaining raw provider arguments.
  for (const { name, id, args: rawArgs } of includeRaw ? rawArgumentChunks(message, object) : []) {
    let args = rawArgs ?? '';
    try {
      args = JSON.stringify(JSON.parse(args));
    } catch {}
    if (!normalized.some((known) => known.name === name && known.id === id && known.args === args))
      calls.push({ name, id, args });
  }
  return calls;
}

export function argumentChunks(
  message: BaseMessage,
  aiMessage: boolean,
  includeRaw = true,
  object: (value: unknown) => value is Record<string, unknown> = isPlainObject,
): ArgumentChunk[] {
  return replyCalls(message, aiMessage, includeRaw, object).map(({ name, id, args }, index) => ({
    ...(name === undefined ? {} : { name }),
    ...(id === undefined ? {} : { id }),
    index,
    args,
  }));
}

export function outputText(
  message: BaseMessage,
  aiMessage: boolean,
  object: (value: unknown) => value is Record<string, unknown> = isPlainObject,
): string {
  return [
    message.text,
    ...replyCalls(message, aiMessage, true, object).map((call) => call.args),
  ].join('\n');
}

/** Complete provider JSON must equal the parsed call, without repairing truncation. */
export function sameJson(text: string, value: unknown): boolean {
  try {
    return JSON.stringify(JSON.parse(text)) === JSON.stringify(value);
  } catch {
    return false;
  }
}
