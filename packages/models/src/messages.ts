// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { BaseMessage } from '@langchain/core/messages';
import { ModelError } from './errors.js';

export interface TextMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export function textContent(message: BaseMessage): string {
  if (typeof message.content === 'string') return message.content;
  if (message.content.every((block) => block.type === 'text' && typeof block.text === 'string'))
    return message.content.map((block) => block.text).join('');
  throw new ModelError('invalid');
}

export function mapMessages(messages: BaseMessage[]): readonly TextMessage[] {
  if (messages.length === 0 || messages.at(-1)?.type !== 'human') throw new ModelError('invalid');
  return messages.map((message, index) => {
    if (
      (message.type === 'system' && index !== 0) ||
      ('tool_calls' in message &&
        Array.isArray(message.tool_calls) &&
        message.tool_calls.length > 0) ||
      ('invalid_tool_calls' in message &&
        Array.isArray(message.invalid_tool_calls) &&
        message.invalid_tool_calls.length > 0) ||
      message.additional_kwargs['tool_calls'] !== undefined ||
      message.additional_kwargs['function_call'] !== undefined
    )
      throw new ModelError('invalid');
    const role =
      message.type === 'human'
        ? 'user'
        : message.type === 'ai'
          ? 'assistant'
          : message.type === 'system'
            ? 'system'
            : undefined;
    if (role === undefined) throw new ModelError('invalid');
    return { role, content: textContent(message) };
  });
}
