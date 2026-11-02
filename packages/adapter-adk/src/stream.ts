// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { ExecutorEvent } from '@galaxie/core';
import type { Event } from '@google/adk';

export const EXECUTOR_ID = 'adk-js';
/** The longest text one `messages` event carries; a longer delta is split. */
export const MAX_DELTA_LENGTH = 4096;

/**
 * Projects ADK events onto the stream modes core already carries (KTD10). Text deltas become
 * `messages` events; tool steps become `updates` markers that hold the offered tool name and a
 * run-wide position, never a call ID, an argument or a result.
 */
export class StreamProjector {
  #position = 0;

  /** The marker for a run that stops to wait for the user; it holds no call or content. */
  paused(): ExecutorEvent {
    return {
      type: 'stream',
      executor: EXECUTOR_ID,
      path: [],
      mode: 'updates',
      data: { step: 'paused', index: this.#position++ },
    };
  }

  project(event: Event): ExecutorEvent[] {
    const parts = event.content?.parts ?? [];
    if (event.partial === true) {
      const text = parts
        .filter((part) => part.thought !== true)
        .map((part) => part.text ?? '')
        .join('');
      const events: ExecutorEvent[] = [];
      for (let start = 0; start < text.length; ) {
        let end = Math.min(start + MAX_DELTA_LENGTH, text.length);
        // Never split a surrogate pair across two events.
        const last = text.charCodeAt(end - 1);
        if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
        events.push({
          type: 'stream',
          executor: EXECUTOR_ID,
          path: [],
          mode: 'messages',
          data: { author: event.author, text: text.slice(start, end) },
        });
        start = end;
      }
      return events;
    }
    const events: ExecutorEvent[] = [];
    for (const part of parts) {
      const call = part.functionCall;
      const response = part.functionResponse;
      const step = call !== undefined ? 'tool_call' : response !== undefined ? 'tool_result' : '';
      const tool = call?.name ?? response?.name;
      if (step === '' || typeof tool !== 'string') continue;
      events.push({
        type: 'stream',
        executor: EXECUTOR_ID,
        path: [],
        mode: 'updates',
        data: { step, tool, index: this.#position++ },
      });
    }
    return events;
  }
}
