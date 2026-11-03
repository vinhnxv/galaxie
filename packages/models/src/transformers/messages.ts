// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { BaseMessage } from '@langchain/core/messages';
import { ModelError } from '../errors.js';
import { textContent } from '../messages.js';
import type { JsonObject, ProtocolMessage, ProtocolToolCall } from './protocol.js';

function toolCallsOf(message: BaseMessage): ProtocolToolCall[] {
  const calls =
    'tool_calls' in message && Array.isArray(message.tool_calls) ? message.tool_calls : [];
  return calls.map((call: { name: string; args: unknown }) => ({
    name: call.name,
    arguments: call.args as JsonObject,
  }));
}

/**
 * Maps chat history to template turns, with assistant tool calls and tool results (ADR-0021
 * decision 10). The shared text-only mapper stays unchanged. Tool call IDs are not carried: the
 * `hermes` template pairs a result with its call by position, so the order is kept as given.
 */
export function mapToolMessages(messages: BaseMessage[]): readonly ProtocolMessage[] {
  const last = messages.at(-1)?.type;
  if (last !== 'human' && last !== 'tool') throw new ModelError('invalid');
  return messages.map((message, index) => {
    if (message.type === 'system' && index !== 0) throw new ModelError('invalid');
    if (
      ('invalid_tool_calls' in message &&
        Array.isArray(message.invalid_tool_calls) &&
        message.invalid_tool_calls.length > 0) ||
      message.additional_kwargs['tool_calls'] !== undefined ||
      message.additional_kwargs['function_call'] !== undefined
    )
      throw new ModelError('invalid');
    const content = textContent(message);
    switch (message.type) {
      case 'system':
        return { role: 'system', content };
      case 'human':
        return { role: 'user', content };
      case 'tool':
        return { role: 'tool', content };
      case 'ai': {
        const toolCalls = toolCallsOf(message);
        return toolCalls.length === 0
          ? { role: 'assistant', content }
          : { role: 'assistant', content, toolCalls };
      }
      default:
        throw new ModelError('invalid');
    }
  });
}
