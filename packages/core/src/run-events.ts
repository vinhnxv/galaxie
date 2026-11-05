// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { ExecutorEvent, RunEvent } from './events.js';
import type { EventId, RunId } from './ids.js';

export class RunEvents {
  private readonly runId: RunId;
  private readonly buffer: RunEvent[] = [];
  private readonly consumers: Set<{ queue: (RunEvent | undefined)[]; flush(): void }> = new Set();
  private sequence: number = 0;
  private ended: boolean = false;

  constructor(runId: RunId) {
    this.runId = runId;
  }

  append(event: ExecutorEvent | { readonly type: 'cancelled' }): void {
    const recorded = Object.freeze({
      ...event,
      eventId: globalThis.crypto.randomUUID() as EventId,
      runId: this.runId,
      sequence: this.sequence++,
    });
    if (event.type !== 'stream') this.buffer.push(recorded);
    for (const consumer of this.consumers) consumer.queue.push(recorded);
    this.ended = ['output', 'error', 'cancelled'].includes(event.type);
  }

  /** Called after the corresponding snapshot has been replaced. */
  notify(): void {
    for (const consumer of this.consumers) consumer.flush();
  }

  iterate(assertCurrent: () => void): AsyncIterable<RunEvent> {
    const owner = this;
    return {
      [Symbol.asyncIterator](): AsyncIterableIterator<RunEvent> {
        let detached = false;
        let checked = false;
        const pending: Array<(result: IteratorResult<RunEvent>) => void> = [];
        const queue: (RunEvent | undefined)[] = [];
        let cursor = 0;
        const done = (): IteratorResult<RunEvent> => ({ done: true, value: undefined });
        const flush = (): void => {
          while (pending.length > 0) {
            const event = queue[cursor];
            if (!detached && event !== undefined) {
              queue[cursor++] = undefined;
              pending.shift()?.({ done: false, value: event });
            } else if (detached || owner.ended) {
              pending.shift()?.(done());
            } else {
              break;
            }
          }
          if (cursor === queue.length) {
            queue.length = 0;
            cursor = 0;
          }
          if (detached || (owner.ended && queue.length === 0)) {
            owner.consumers.delete(consumer);
            queue.length = 0;
          }
        };
        const consumer = { queue, flush };
        return {
          [Symbol.asyncIterator](): AsyncIterableIterator<RunEvent> {
            return this;
          },
          next(): Promise<IteratorResult<RunEvent>> {
            if (detached) return Promise.resolve(done());
            if (!checked) {
              checked = true;
              try {
                assertCurrent();
                queue.push(...owner.buffer);
                owner.consumers.add(consumer);
              } catch (error) {
                detached = true;
                return Promise.reject(error);
              }
            }
            return new Promise((resolve) => {
              pending.push(resolve);
              flush();
            });
          },
          return(): Promise<IteratorResult<RunEvent>> {
            detached = true;
            flush();
            return Promise.resolve(done());
          },
        };
      },
    };
  }
}
