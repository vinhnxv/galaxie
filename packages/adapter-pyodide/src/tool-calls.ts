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
function fragmentsOf(message: BaseMessage): ArgumentChunk[] {
  const chunks = isAIMessageChunk(message as AIMessageChunk)
    ? (message as AIMessageChunk).tool_call_chunks
    : undefined;
  return chunks?.length ? chunks : argumentChunks(message);
}
// Streamed tool-call fragments are grouped by index, then by ID; a fragment with
// neither continues the latest call. The slot becomes the index Python groups by.
export class GrowingOutput {
  private text = '';
  private readonly argumentsText = new Map<number, string>();
  private readonly rawArgumentsText: string[] = [];
  private readonly ids = new Map<number, string>();
  private readonly names = new Map<number, string>();
  private readonly slots = new Map<string, number>();
  private latest: number | undefined;
  private next = 0;
  private current: ToolCallDelta[] = [];
  toolCallIds(): readonly string[] {
    return [...this.ids.values()];
  }
  toolCallNames(): readonly string[] {
    return [...this.names.values()];
  }
  /** The latest chunk's fragments, indexed by the slots used for output checks. */
  deltas(): readonly ToolCallDelta[] {
    return this.current;
  }
  private slot(fragment: ArgumentChunk): number {
    const keys = [
      ...(fragment.index === undefined ? [] : [JSON.stringify(['index', fragment.index])]),
      ...(fragment.id === undefined ? [] : [JSON.stringify(['id', fragment.id])]),
    ];
    const known = keys.map((key) => this.slots.get(key)).find((slot) => slot !== undefined);
    const slot = known ?? (keys.length || this.latest === undefined ? this.next : this.latest);
    for (const key of keys) if (!this.slots.has(key)) this.slots.set(key, slot);
    if (slot === this.next) this.next += 1;
    this.latest = slot;
    return slot;
  }
  append(message: BaseMessage): string {
    this.text += message.text;
    this.current = fragmentsOf(message).map((fragment) => {
      const index = this.slot(fragment);
      if (fragment.id !== undefined) this.ids.set(index, (this.ids.get(index) ?? '') + fragment.id);
      if (fragment.name !== undefined)
        this.names.set(index, (this.names.get(index) ?? '') + fragment.name);
      if (fragment.args !== undefined)
        this.argumentsText.set(index, (this.argumentsText.get(index) ?? '') + fragment.args);
      return {
        index,
        ...(fragment.id === undefined ? {} : { id: fragment.id }),
        type: 'function',
        function: {
          ...(fragment.name === undefined ? {} : { name: fragment.name }),
          ...(fragment.args === undefined ? {} : { arguments: fragment.args }),
        },
      };
    });
    const fragments = isAIMessageChunk(message as AIMessageChunk)
      ? (message as AIMessageChunk).tool_call_chunks
      : undefined;
    if (fragments?.length) {
      for (const raw of rawArgumentChunks(message)) {
        const mirrored = fragments.some(
          (fragment, position) =>
            fragment.args === raw.args &&
            (fragment.name === undefined || raw.name === undefined || fragment.name === raw.name) &&
            (fragment.id !== undefined && raw.id !== undefined
              ? fragment.id === raw.id
              : (fragment.index ?? position) === raw.index),
        );
        if (!mirrored) this.rawArgumentsText.push(raw.args ?? '');
      }
    }
    return [
      this.text,
      ...[...this.argumentsText.values(), ...this.rawArgumentsText].filter(
        (value) => value.length > 0,
      ),
    ].join('\n');
  }
}
