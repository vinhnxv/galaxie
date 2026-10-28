// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { ExecutorEvent, RunEvent } from './events.js';
import type { EventId, RunId } from './ids.js';

/** In-memory replay and live delivery; executor payloads remain passed by reference. */
export class RunEvents {
  private readonly runId: RunId;
  private readonly buffer: RunEvent[] = [];
  private readonly consumers: Set<() => void> = new Set();
  private ended: boolean = false;

  constructor(runId: RunId) {
    this.runId = runId;
  }

  append(event: ExecutorEvent | { readonly type: 'cancelled' }): void {
    this.buffer.push(
      Object.freeze({
        ...event,
        eventId: globalThis.crypto.randomUUID() as EventId,
        runId: this.runId,
        sequence: this.buffer.length,
      }),
    );
    this.ended = ['output', 'error', 'cancelled'].includes(event.type);
  }

  /** Called after the corresponding snapshot has been replaced. */
  notify(): void {
    for (const consumer of this.consumers) consumer();
  }

  iterate(assertCurrent: () => void): AsyncIterable<RunEvent> {
    const owner = this;
    return {
      [Symbol.asyncIterator](): AsyncIterableIterator<RunEvent> {
        let sequence = 0;
        let detached = false;
        let checked = false;
        const pending: Array<(result: IteratorResult<RunEvent>) => void> = [];
        const done = (): IteratorResult<RunEvent> => ({ done: true, value: undefined });
        const flush = (): void => {
          while (pending.length > 0) {
            const event = owner.buffer[sequence];
            if (!detached && event !== undefined) {
              sequence++;
              pending.shift()?.({ done: false, value: event });
            } else if (detached || owner.ended) {
              pending.shift()?.(done());
            } else {
              break;
            }
          }
          if (detached || (owner.ended && sequence === owner.buffer.length)) {
            owner.consumers.delete(flush);
          }
        };
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
              } catch (error) {
                detached = true;
                return Promise.reject(error);
              }
            }
            return new Promise((resolve) => {
              pending.push(resolve);
              owner.consumers.add(flush);
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
