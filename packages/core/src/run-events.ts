// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { GalaxieError, toErrorInfo } from './errors.js';
import type { ExecutorEvent, HostEvent, RunEvent } from './events.js';
import type { EventId, RunId } from './ids.js';

const MAX_PENDING_EVENTS = 1024;

export class RunEvents {
  private readonly runId: RunId;
  private readonly buffer: RunEvent[] = [];
  private readonly consumers: Set<{ append(event: RunEvent): void; flush(): void }> = new Set();
  private sequence: number = 0;
  private ended: boolean = false;

  constructor(runId: RunId) {
    this.runId = runId;
  }

  append(event: ExecutorEvent | HostEvent): void {
    const recorded = Object.freeze({
      ...event,
      eventId: globalThis.crypto.randomUUID() as EventId,
      runId: this.runId,
      sequence: this.sequence++,
    });
    if (event.type !== 'stream') this.buffer.push(recorded);
    for (const consumer of this.consumers) consumer.append(recorded);
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
        let overflow = false;
        let replayCursor = 0;
        let replayEnd = 0;
        const pending: Array<{
          resolve(result: IteratorResult<RunEvent>): void;
          reject(error: Error): void;
        }> = [];
        const queue: RunEvent[] = [];
        const done = (): IteratorResult<RunEvent> => ({ done: true, value: undefined });
        const failure = (): GalaxieError =>
          new GalaxieError('budget_exceeded', toErrorInfo('budget_exceeded').message);
        const flush = (): void => {
          if (detached || overflow) {
            owner.consumers.delete(consumer);
            queue.length = 0;
            if (pending.length > 0) {
              for (const next of pending.splice(0)) {
                if (detached) next.resolve(done());
                else next.reject(failure());
              }
              detached = true;
            }
            return;
          }
          while (pending.length > 0) {
            const event = replayCursor < replayEnd ? owner.buffer[replayCursor++] : queue.shift();
            if (event !== undefined) {
              pending.shift()?.resolve({ done: false, value: event });
            } else if (owner.ended) {
              pending.shift()?.resolve(done());
            } else {
              break;
            }
          }
          if (owner.ended && replayCursor === replayEnd && queue.length === 0) {
            owner.consumers.delete(consumer);
          }
        };
        const consumer = {
          append(event: RunEvent): void {
            if (detached || overflow) return;
            if (queue.length === MAX_PENDING_EVENTS) {
              overflow = true;
              queue.length = 0;
            } else queue.push(event);
          },
          flush,
        };
        return {
          [Symbol.asyncIterator](): AsyncIterableIterator<RunEvent> {
            return this;
          },
          next(): Promise<IteratorResult<RunEvent>> {
            if (detached) return Promise.resolve(done());
            if (overflow) {
              detached = true;
              return Promise.reject(failure());
            }
            if (!checked) {
              checked = true;
              try {
                assertCurrent();
                replayEnd = owner.buffer.length;
                owner.consumers.add(consumer);
              } catch (error) {
                detached = true;
                return Promise.reject(error);
              }
            }
            return new Promise((resolve, reject) => {
              pending.push({ resolve, reject });
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
