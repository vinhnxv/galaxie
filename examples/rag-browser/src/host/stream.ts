// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { RunEvent } from '@galaxie/core';

/** Render only checked answer message text, never graph state or tool results. */
export function answerDelta(event: RunEvent): string {
  if (event.type !== 'stream' || event.mode !== 'messages' || !Array.isArray(event.data)) return '';
  const [message, metadata] = event.data as unknown[];
  if (
    !message ||
    typeof message !== 'object' ||
    !metadata ||
    typeof metadata !== 'object' ||
    Reflect.get(metadata, 'langgraph_node') !== 'generateAnswer' ||
    !['ai', 'AIMessageChunk'].includes(Reflect.get(message, 'type')) ||
    typeof Reflect.get(message, 'content') !== 'string' ||
    (Reflect.get(message, 'tool_calls')?.length ?? 0) !== 0
  )
    return '';
  return Reflect.get(message, 'content') as string;
}
