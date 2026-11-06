// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  isAIMessage,
  SystemMessage,
  type ToolCall,
  ToolMessage,
} from '@langchain/core/messages';
import { ModelError } from '../errors.js';
import { textContent } from '../messages.js';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function equal(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right))
    return left.length === right.length && left.every((value, index) => equal(value, right[index]));
  if (record(left) && record(right)) {
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => Object.hasOwn(right, key) && equal(left[key], right[key]))
    );
  }
  return left === right;
}

function callsOf(message: AIMessage): ToolCall[] {
  const calls = (message.tool_calls ?? []).map(({ id, name, args }) => {
    if (
      typeof id !== 'string' ||
      id === '' ||
      typeof name !== 'string' ||
      name === '' ||
      !record(args)
    )
      throw new ModelError('invalid');
    return { type: 'tool_call' as const, id, name, args };
  });
  const mirror: unknown = message.additional_kwargs['tool_calls'];
  if (mirror !== undefined) {
    if (!Array.isArray(mirror) || mirror.length !== calls.length) throw new ModelError('invalid');
    for (const [index, raw] of mirror.entries()) {
      const fn = record(raw) ? raw['function'] : undefined;
      if (
        !record(raw) ||
        !record(fn) ||
        raw['type'] !== 'function' ||
        typeof fn['arguments'] !== 'string'
      )
        throw new ModelError('invalid');
      let args: unknown;
      try {
        args = JSON.parse(fn['arguments']);
      } catch {
        throw new ModelError('invalid');
      }
      const call = calls[index];
      if (
        call === undefined ||
        raw['id'] !== call.id ||
        fn['name'] !== call.name ||
        !equal(args, call.args)
      )
        throw new ModelError('invalid');
    }
  }
  return calls;
}

/** Tool history keeps provider IDs and strips all unrelated message metadata. */
export function mapToolMessages(messages: BaseMessage[]): BaseMessage[] {
  const last = messages.at(-1)?.type;
  if (last !== 'human' && last !== 'tool') throw new ModelError('invalid');
  const pending = new Set<string>();
  // Invalid calls are never sent to the endpoint, so they are dropped from the history.
  const mapped = messages.map((message, index) => {
    if (
      (message.type === 'system' && index !== 0) ||
      message.additional_kwargs['function_call'] !== undefined ||
      (message.type !== 'ai' && message.additional_kwargs['tool_calls'] !== undefined)
    )
      throw new ModelError('invalid');
    const content = textContent(message);
    if (isAIMessage(message)) {
      const calls = callsOf(message);
      for (const call of calls) {
        if (call.id === undefined || pending.has(call.id)) throw new ModelError('invalid');
        pending.add(call.id);
      }
      return new AIMessage({ content, tool_calls: calls });
    }
    if (ToolMessage.isInstance(message)) {
      if (!pending.delete(message.tool_call_id)) throw new ModelError('invalid');
      return new ToolMessage({ content, tool_call_id: message.tool_call_id });
    }
    if (message.type === 'system') return new SystemMessage(content);
    if (message.type === 'human') return new HumanMessage(content);
    throw new ModelError('invalid');
  });
  // A call without its result would only be rejected by the endpoint.
  if (pending.size > 0) throw new ModelError('invalid');
  return mapped;
}
