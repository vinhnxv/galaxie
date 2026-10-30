// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import {
  type AIMessageChunk,
  type BaseMessage,
  isAIMessage,
  isAIMessageChunk,
  type StandardMessageStructure,
} from '@langchain/core/messages';
import { type ToolCall, type ToolCallDelta, validToolCall } from './bridge.js';
import { adapterFailure } from './errors.js';

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
function argumentChunks(message: BaseMessage, includeRaw = true): ArgumentChunk[] {
  if (!isAIMessage(message)) return [];
  const calls = [
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
  for (const { name, id, args: rawArgs } of includeRaw ? rawArgumentChunks(message) : []) {
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

export function outputText(message: BaseMessage): string {
  return [message.text, ...argumentChunks(message).map((call) => call.args)].join('\n');
}
// Python acts on the parsed calls only; raw provider mirrors stay in the checked text.
export function toolCalls(message: BaseMessage): ToolCall[] {
  return argumentChunks(message, false).map(({ id, name, args }) => {
    const call = { id, type: 'function', function: { name, arguments: args ?? '' } };
    if (!validToolCall(call)) throw adapterFailure('invalid');
    return call;
  });
}
export function toolDeltas(message: BaseMessage): ToolCallDelta[] {
  const chunks = isAIMessageChunk(message as AIMessageChunk)
    ? (message as AIMessageChunk).tool_call_chunks
    : undefined;
  const fragments = chunks?.length ? chunks : argumentChunks(message);
  return fragments.map((fragment, position) => ({
    index: fragment.index ?? position,
    ...(fragment.id === undefined ? {} : { id: fragment.id }),
    type: 'function',
    function: {
      ...(fragment.name === undefined ? {} : { name: fragment.name }),
      ...(fragment.args === undefined ? {} : { arguments: fragment.args }),
    },
  }));
}
export class GrowingOutput {
  private text = '';
  private readonly argumentsText: string[] = [];
  private readonly slots = new Map<string, number>();
  append(message: BaseMessage): string {
    this.text += message.text;
    const fragments = isAIMessageChunk(message as AIMessageChunk)
      ? (message as AIMessageChunk).tool_call_chunks
      : undefined;
    if (fragments?.length) {
      for (const [position, fragment] of fragments.entries()) {
        const key = JSON.stringify(
          fragment.index !== undefined
            ? ['index', fragment.index]
            : fragment.id !== undefined
              ? ['id', fragment.id]
              : ['position', position],
        );
        let slot = this.slots.get(key);
        if (slot === undefined) {
          slot = this.argumentsText.length;
          this.slots.set(key, slot);
          this.argumentsText.push('');
        }
        this.argumentsText[slot] = (this.argumentsText[slot] ?? '') + (fragment.args ?? '');
      }
      for (const raw of rawArgumentChunks(message)) {
        const mirrored = fragments.some(
          (fragment, position) =>
            fragment.args === raw.args &&
            (fragment.name === undefined || raw.name === undefined || fragment.name === raw.name) &&
            (fragment.id !== undefined && raw.id !== undefined
              ? fragment.id === raw.id
              : (fragment.index ?? position) === raw.index),
        );
        if (!mirrored) this.argumentsText.push(raw.args ?? '');
      }
    } else this.argumentsText.push(...argumentChunks(message).map((call) => call.args ?? ''));
    return [this.text, ...this.argumentsText.filter((value) => value.length > 0)].join('\n');
  }
}
