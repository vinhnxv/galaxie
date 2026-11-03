// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { TransformersWorker } from '../../src/transformers/engine.js';

/** A Worker stand-in that records what the page posts and lets a test play the Worker's part. */
export class FakeTransformersWorker implements TransformersWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly posted: Record<string, unknown>[] = [];
  terminated = 0;

  postMessage(message: unknown): void {
    this.posted.push(message as Record<string, unknown>);
  }

  terminate(): void {
    this.terminated += 1;
  }

  /** Delivers a message to the page as the Worker would. */
  emit(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  fail(): void {
    this.onerror?.({ preventDefault() {} } as unknown as ErrorEvent);
  }

  of(type: string): Record<string, unknown>[] {
    return this.posted.filter((message) => message['type'] === type);
  }
}

export const wasmDevice = {
  backend: 'wasm',
  thread: 'worker',
  vendor: 'test',
  architecture: 'test',
} as const;

export const request = {
  messages: [{ role: 'user', content: 'hello' }],
  maxTokens: 16,
  temperature: 0,
} as const;

/** Lets queued promise callbacks run. */
export async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
