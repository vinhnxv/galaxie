// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { BaseMessage } from '@langchain/core/messages';
import { ModelError } from '../errors.js';
import { textContent } from '../messages.js';
import type { JsonObject, ProtocolMessage, ProtocolToolCall } from './protocol.js';

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One call from the OpenAI-format mirror: a function name and arguments as a JSON object string. */
function mirroredCall(call: unknown): ProtocolToolCall {
  const fn = plainRecord(call) ? call['function'] : undefined;
  if (!plainRecord(fn) || typeof fn['name'] !== 'string' || fn['name'] === '')
    throw new ModelError('invalid');
  const text = fn['arguments'];
  if (typeof text !== 'string') throw new ModelError('invalid');
  let args: unknown;
  try {
    args = JSON.parse(text);
  } catch {
    throw new ModelError('invalid');
  }
  if (!plainRecord(args)) throw new ModelError('invalid');
  return { name: fn['name'], arguments: args as JsonObject };
}

/**
 * The calls of an assistant turn. Adapters that carry provider-format history store them as the
 * OpenAI-format `additional_kwargs.tool_calls` mirror, and LangChain then derives `tool_calls` from
 * it. The mirror must be exact, and `tool_calls`, when present beside it, must say the same.
 * IDs are dropped: results pair by position.
 */
function toolCallsOf(message: BaseMessage): ProtocolToolCall[] {
  const native: ProtocolToolCall[] = (
    'tool_calls' in message && Array.isArray(message.tool_calls) ? message.tool_calls : []
  ).map((call: { name: string; args: unknown }) => ({
    name: call.name,
    arguments: call.args as JsonObject,
  }));
  const mirror: unknown = message.additional_kwargs['tool_calls'];
  if (mirror === undefined) return native;
  if (!Array.isArray(mirror)) throw new ModelError('invalid');
  const mirrored = mirror.map(mirroredCall);
  if (native.length > 0 && JSON.stringify(native) !== JSON.stringify(mirrored))
    throw new ModelError('invalid');
  return mirrored;
}

/**
 * Maps chat history to template turns, with assistant tool calls and tool results (ADR-0021
 * decision 10). The shared text-only mapper stays unchanged. Tool call IDs are not carried: the
 * `hermes` template pairs a result with its call by position, so the order is kept as given.
 */
export function mapToolMessages(messages: BaseMessage[]): readonly ProtocolMessage[] {
  const last = messages.at(-1)?.type;
  if (last !== 'human' && last !== 'tool') throw new ModelError('invalid');
  // Results pair with calls by position, so a result needs a call of the turn before it.
  let pending = 0;
  return messages.map((message, index) => {
    if (message.type === 'system' && index !== 0) throw new ModelError('invalid');
    if (
      ('invalid_tool_calls' in message &&
        Array.isArray(message.invalid_tool_calls) &&
        message.invalid_tool_calls.length > 0) ||
      (message.type !== 'ai' && message.additional_kwargs['tool_calls'] !== undefined) ||
      message.additional_kwargs['function_call'] !== undefined
    )
      throw new ModelError('invalid');
    const content = textContent(message);
    switch (message.type) {
      case 'system':
        pending = 0;
        return { role: 'system', content };
      case 'human':
        pending = 0;
        return { role: 'user', content };
      case 'tool':
        if (pending === 0) throw new ModelError('invalid');
        pending -= 1;
        return { role: 'tool', content };
      case 'ai': {
        const toolCalls = toolCallsOf(message);
        pending = toolCalls.length;
        return toolCalls.length === 0
          ? { role: 'assistant', content }
          : { role: 'assistant', content, toolCalls };
      }
      default:
        throw new ModelError('invalid');
    }
  });
}
