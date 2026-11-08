// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  type ArgumentChunk,
  hasArgumentMirror,
  isRecord as object,
  rawArgumentChunks,
  argumentChunks as sharedArgumentChunks,
  outputText as sharedOutputText,
} from '@galaxie-ai/adapter-kit';
import {
  type AIMessageChunk,
  type BaseMessage,
  isAIMessage,
  isAIMessageChunk,
} from '@langchain/core/messages';
import { type ToolCall, type ToolCallDelta, validToolCall } from './bridge.js';
import { adapterFailure } from './errors.js';

function argumentChunks(message: BaseMessage, includeRaw = true): ArgumentChunk[] {
  return sharedArgumentChunks(message, isAIMessage(message), includeRaw, object);
}

export function outputText(message: BaseMessage): string {
  return sharedOutputText(message, isAIMessage(message), object);
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
      for (const raw of rawArgumentChunks(message, object)) {
        const mirrored = hasArgumentMirror(raw, fragments);
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
