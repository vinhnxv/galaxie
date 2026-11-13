// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { Event } from '@google/adk';
import { GalaxieSessionService } from '../../src/session.js';

/** Change the adapter's stored and yielded author while retaining ADK's signed local history. */
export async function withAuthor<T>(
  match: (event: Event) => boolean,
  author: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const original = GalaxieSessionService.prototype.appendEvent;
  GalaxieSessionService.prototype.appendEvent = async function (request) {
    if (!match(request.event)) return original.call(this, request);
    const native = { ...request.event };
    if (author === undefined) delete request.event.author;
    else request.event.author = author;
    const event = await original.call(this, request);
    // The integrity plugin checks the invocation's local history before calling a tool.
    // Preserve that signed view; the adapter's separate stored copy and yielded event
    // carry the altered author so its pause admission is exercised independently.
    const index = request.session.events.findIndex((entry) => entry.id === event.id);
    if (index >= 0) request.session.events[index] = native;
    return event;
  };
  try {
    return await run();
  } finally {
    GalaxieSessionService.prototype.appendEvent = original;
  }
}
