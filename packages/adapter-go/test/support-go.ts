// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { RunEvent } from '@galaxie/core';
import type { GoWorkerPort } from '../src/index.js';
import {
  type BootMessage,
  encodeWorkerMessage,
  type HostMessage,
  parseHostMessage,
  type WorkerMessage,
} from '../src/protocol.js';

export interface ProgramApi {
  readonly request: {
    readonly entry: string;
    readonly prompt: string;
    readonly conversation: string;
    readonly resume?: {
      readonly interactionId: string;
      readonly action: string;
      readonly payload?: unknown;
    };
  };
  call(op: 'model' | 'capability', payload: unknown): Promise<string>;
  readonly cancelled: Promise<void>;
}

export type Program = (api: ProgramApi) => Promise<string>;

export const okResult = (output: string): string => JSON.stringify({ ok: true, output });
export const approvalRequest = {
  surfaceId: 'main',
  viewRevision: 'r1',
  component: 'conformance.Approval/v1',
  props: { count: 1 },
};
export const pausedResult = (
  interactionId: string = 'a'.repeat(64),
  request: unknown = approvalRequest,
): string => JSON.stringify({ ok: true, paused: { interactionId, request } });
export const failResult = (code: string): string => JSON.stringify({ ok: false, code });

export class FakeGoWorker implements GoWorkerPort {
  readonly received: Exclude<HostMessage, BootMessage>[] = [];
  readonly sentToPage: string[] = [];
  terminated = false;
  readonly #messages = new Set<(event: { readonly data: unknown }) => void>();
  readonly #errors = new Set<() => void>();
  readonly #replies = new Map<
    string,
    { resolve(text: string): void; reject(error: Error): void }
  >();
  #cancel = (): void => {};
  #runId: string | undefined;
  #calls = 0;
  readonly #program: Program;
  readonly #silentOnCancel: boolean;
  constructor(
    program: Program,
    options: { readonly build?: WorkerMessage; readonly silentOnCancel?: boolean } = {},
  ) {
    this.#program = program;
    this.#build = options.build ?? { v: 1, kind: 'ready', coldStartMs: 3 };
    this.#silentOnCancel = options.silentOnCancel ?? false;
  }
  readonly #build: WorkerMessage;
  postMessage(message: string): void {
    const host = parseHostMessage(message);
    if (host === undefined) {
      queueMicrotask(() => this.emit(this.#build));
      return;
    }
    this.received.push(host);
    if (host.kind === 'run') this.#start(host.runId, host.request);
    else if (host.kind === 'cancel') {
      if (!this.#silentOnCancel) this.#cancel();
    } else {
      const pending = this.#replies.get(host.id);
      this.#replies.delete(host.id);
      if (host.ok) pending?.resolve(host.payload);
      else pending?.reject(new Error(host.code));
    }
  }
  #start(runId: string, request: string): void {
    this.#runId = runId;
    const cancelled = new Promise<void>((resolve) => {
      this.#cancel = resolve;
    });
    const api: ProgramApi = {
      request: JSON.parse(request) as ProgramApi['request'],
      cancelled,
      call: (op, payload) =>
        new Promise<string>((resolve, reject) => {
          const id = `c${++this.#calls}`;
          this.#replies.set(id, { resolve, reject });
          this.emit({
            v: 1,
            kind: 'call',
            runId,
            id,
            op,
            payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
          });
        }),
    };
    void this.#program(api).then(
      (result) => this.emit({ v: 1, kind: 'done', runId, result }),
      () => this.emit({ v: 1, kind: 'done', runId, result: failResult('executor_error') }),
    );
  }
  emitCall(id: string, op: 'model' | 'capability', payload: string): void {
    this.emit({ v: 1, kind: 'call', runId: this.#runId ?? 'r1', id, op, payload });
  }
  emit(message: WorkerMessage): void {
    const encoded = encodeWorkerMessage(message);
    this.sentToPage.push(encoded);
    for (const listener of this.#messages) listener({ data: encoded });
  }
  fail(): void {
    for (const listener of this.#errors) listener();
  }
  addEventListener(type: 'message' | 'error', listener: never): void {
    if (type === 'message') this.#messages.add(listener);
    else this.#errors.add(listener);
  }
  removeEventListener(type: 'message' | 'error', listener: never): void {
    if (type === 'message') this.#messages.delete(listener);
    else this.#errors.delete(listener);
  }
  terminate(): void {
    this.terminated = true;
  }
}

export async function collect(source: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}
