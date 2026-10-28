// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { Arm, Availability, LoadInfo, Session } from './types.js';
import { WorkerClient } from './worker-rpc.js';
export class MockArm implements Arm {
  readonly id = 'mock';
  readonly model = { id: 'deterministic-mock', revision: 'v1' };
  readonly engineVersion = '1';
  readonly inWorker = true;
  readonly decoding = 'greedy';
  readonly schemaMechanism = 'deterministic schema fixture';
  readonly sameCheckpointAs = null;
  #client: WorkerClient | undefined;
  readonly failure: string | null;
  constructor(failure: string | null) {
    this.failure = failure;
  }
  async probe(): Promise<Availability> {
    return { status: 'available' };
  }
  async load(progress: (loaded: number, total?: number) => void): Promise<LoadInfo> {
    this.#client = new WorkerClient(
      new Worker(new URL('./mock.worker.ts', import.meta.url), {
        type: 'module',
        name: this.failure ?? '',
      }),
    );
    return this.#client.load(progress);
  }
  async openSession(): Promise<Session> {
    if (!this.#client) throw new Error('not_loaded');
    return this.#client.openSession();
  }
  async dispose(): Promise<void> {
    await this.#client?.dispose();
    this.#client = undefined;
  }
}
