// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  emptySnapshot,
  type InitInput,
  invalidMessage,
  parseEvent,
  parseMessage,
  type RetrievalMessage,
  type RetrievalSnapshot,
  type SearchInput,
  type SearchResult,
} from './protocol.js';

type Command = RetrievalMessage extends infer Message
  ? Message extends RetrievalMessage
    ? Omit<Message, 'id'>
    : never
  : never;
export class RetrievalClient {
  private readonly worker: Worker;
  private nextId: number = 1;
  private terminalError: string | undefined;
  private snapshot: RetrievalSnapshot = { ...emptySnapshot };
  private readonly listeners: Set<() => void> = new Set();
  private readonly pending: Map<
    number,
    { resolve(value: RetrievalSnapshot | SearchResult): void; reject(error: Error): void }
  > = new Map();
  constructor(worker: Worker) {
    this.worker = worker;
    worker.addEventListener('message', this.receive);
    worker.addEventListener('error', this.failure);
    worker.addEventListener('messageerror', this.failure);
  }
  private update(snapshot: RetrievalSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
  private readonly receive = (message: MessageEvent<unknown>): void => {
    try {
      const event = parseEvent(message.data);
      if (event.type === 'progress' || event.type === 'ready') this.update(event.snapshot);
      else if (event.type === 'failed') {
        this.update(event.snapshot);
        this.pending.get(event.id)?.reject(new Error(event.message));
        this.pending.delete(event.id);
      } else if (event.type === 'result') {
        this.pending.get(event.id)?.resolve(event.result);
        this.pending.delete(event.id);
      }
    } catch {
      this.fail(invalidMessage);
    }
  };
  private readonly failure = (): void => {
    this.fail('The retrieval Worker is unavailable.');
  };
  private fail(message: string): void {
    this.terminalError = message;
    this.update({ ...this.snapshot, status: 'failed', message });
    for (const operation of this.pending.values()) operation.reject(new Error(message));
    this.pending.clear();
  }
  private request(command: Command): Promise<RetrievalSnapshot | SearchResult> {
    if (this.terminalError) return Promise.reject(new Error(this.terminalError));
    const id = this.nextId++;
    const message = parseMessage({ ...command, id });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage(message);
      } catch {
        this.pending.delete(id);
        reject(new Error(invalidMessage));
      }
    });
  }
  init(input: InitInput): Promise<RetrievalSnapshot> {
    return this.request({ type: 'init', input }) as Promise<RetrievalSnapshot>;
  }
  consent(): Promise<RetrievalSnapshot> {
    return this.request({ type: 'consent' }) as Promise<RetrievalSnapshot>;
  }
  paste(text: string): Promise<RetrievalSnapshot> {
    return this.request({ type: 'paste', text }) as Promise<RetrievalSnapshot>;
  }
  search(input: SearchInput): Promise<SearchResult> {
    return this.request({ type: 'search', input }) as Promise<SearchResult>;
  }
  clear(): Promise<RetrievalSnapshot> {
    return this.request({ type: 'clear' }) as Promise<RetrievalSnapshot>;
  }
  removeModel(): Promise<RetrievalSnapshot> {
    return this.request({ type: 'remove-model' }) as Promise<RetrievalSnapshot>;
  }
  getSnapshot = (): RetrievalSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  dispose(): void {
    this.worker.removeEventListener('message', this.receive);
    this.worker.removeEventListener('error', this.failure);
    this.worker.removeEventListener('messageerror', this.failure);
    this.worker.terminate();
    this.fail('The retrieval Worker is unavailable.');
    this.listeners.clear();
  }
}
