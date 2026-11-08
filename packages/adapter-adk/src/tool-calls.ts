// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  isRecord,
  type ReplyCall,
  outputText as sharedOutputText,
  replyCalls as sharedReplyCalls,
} from '@galaxie-ai/adapter-kit';
import { type BaseMessage, isAIMessage } from '@langchain/core/messages';

export type { ReplyCall };

export function replyCalls(message: BaseMessage): ReplyCall[] {
  return sharedReplyCalls(message, isAIMessage(message), true, isRecord);
}

export function outputText(message: BaseMessage): string {
  return sharedOutputText(message, isAIMessage(message), isRecord);
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
