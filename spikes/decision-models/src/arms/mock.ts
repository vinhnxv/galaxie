// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

// Worker lifecycle pattern adapted from spikes/b-local-inference/src/arms/mock.ts.
import type { Availability } from '../results.js';
import type { Arm, DecisionReply, DecisionRequest, LoadRecord } from './types.js';
import { WorkerClient } from './worker-rpc.js';

export class MockArm implements Arm {
  readonly id = 'mock';
  readonly failure: string | null;
  readonly noConfidence: boolean;
  #client: WorkerClient | undefined;
  constructor(failure: string | null, noConfidence: boolean) {
    this.failure = failure;
    this.noConfidence = noConfidence;
  }
  async probe(): Promise<Availability> {
    return { status: 'available', reason: null, raw: null };
  }
  async load(progress: (loaded: number, total: number | null) => void): Promise<LoadRecord> {
    this.#client = new WorkerClient(
      new Worker(new URL('./mock.worker.ts', import.meta.url), { type: 'module' }),
    );
    return this.#client.call(
      'load',
      { failure: this.failure, noConfidence: this.noConfidence },
      undefined,
      progress,
    );
  }
  async decide(request: DecisionRequest, signal: AbortSignal): Promise<DecisionReply> {
    if (!this.#client) throw new Error('not_loaded');
    return this.#client.call('decide', request, signal);
  }
  async dispose(): Promise<void> {
    this.#client?.terminate();
    this.#client = undefined;
  }
}
