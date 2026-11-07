// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  type ArgumentChunk,
  isRecord,
  type ReplyCall,
  outputText as sharedOutputText,
  replyCalls as sharedReplyCalls,
} from '@galaxie/adapter-kit';
import {
  type AIMessage,
  type AIMessageChunk,
  type BaseMessage,
  isAIMessage,
} from '@langchain/core/messages';

export type { ReplyCall };

export function replyCalls(message: BaseMessage): ReplyCall[] {
  return sharedReplyCalls(message, isAIMessage(message), true, isRecord);
}

export function outputText(message: BaseMessage): string {
  return sharedOutputText(message, isAIMessage(message), isRecord);
}

export function fragmentsOf(message: AIMessage | AIMessageChunk): ArgumentChunk[] {
  return 'tool_call_chunks' in message ? (message.tool_call_chunks ?? []) : [];
}

/**
 * What the output check sees while a streamed reply grows: the text so far and every argument
 * string, plus the raw argument fragments, which can be cut off mid-JSON before any call parses.
 */
export function growingText(message: AIMessage | AIMessageChunk): string {
  return [outputText(message), ...fragmentsOf(message).map((call) => call.args ?? '')]
    .filter((value) => value !== '')
    .join('\n');
}
