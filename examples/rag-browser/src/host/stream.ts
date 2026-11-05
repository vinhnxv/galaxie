// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { RunEvent } from '@galaxie/core';

export function startsModelTurn(event: RunEvent): boolean {
  return (
    event.type === 'stream' &&
    event.mode === 'updates' &&
    typeof event.data === 'object' &&
    event.data !== null &&
    ((event.executor === 'pydantic-ai-python' &&
      Reflect.get(event.data, 'kind') === 'model-request') ||
      (event.executor === 'dspy-python' && Reflect.get(event.data, 'kind') === 'model'))
  );
}

/** Render only checked answer message text, never graph state or tool results. */
export function answerDelta(event: RunEvent): string {
  if (event.type === 'stream' && event.executor === 'dspy-python') {
    return event.mode === 'messages' &&
      event.data !== null &&
      typeof event.data === 'object' &&
      Reflect.get(event.data, 'field') === 'answer' &&
      typeof Reflect.get(event.data, 'text') === 'string'
      ? (Reflect.get(event.data, 'text') as string)
      : '';
  }
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
