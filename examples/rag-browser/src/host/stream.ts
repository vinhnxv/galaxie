// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { RunEvent } from '@galaxie/core';

/** A pydantic-ai model request starts a new turn, so earlier tool-call or retry text is not the answer. */
export function startsModelTurn(event: RunEvent): boolean {
  return (
    event.type === 'stream' &&
    event.executor === 'pydantic-ai-python' &&
    event.mode === 'updates' &&
    typeof event.data === 'object' &&
    event.data !== null &&
    Reflect.get(event.data, 'kind') === 'model-request'
  );
}

/** Render only checked answer message text, never graph state or tool results. */
export function answerDelta(event: RunEvent): string {
  if (event.type !== 'stream' || event.mode !== 'messages' || !Array.isArray(event.data)) return '';
  const [message, metadata] = event.data as unknown[];
  if (
    !message ||
    typeof message !== 'object' ||
    !metadata ||
    typeof metadata !== 'object' ||
    (event.executor === 'pydantic-ai-python'
      ? Object.keys(metadata).length !== 0
      : Reflect.get(metadata, 'langgraph_node') !== 'generateAnswer') ||
    !['ai', 'AIMessageChunk'].includes(Reflect.get(message, 'type')) ||
    typeof Reflect.get(message, 'content') !== 'string' ||
    (Reflect.get(message, 'tool_calls')?.length ?? 0) !== 0
  )
    return '';
  return Reflect.get(message, 'content') as string;
}
