// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { gpuProbe } from '../device.js';
import type { Arm, Availability, LoadInfo, ModelInfo, Session } from './types.js';
import { WorkerClient } from './worker-rpc.js';
export class TransformersArm implements Arm {
  readonly id = 'transformers-js';
  readonly model = {
    id: 'onnx-community/Qwen2.5-1.5B-Instruct',
    revision: 'd54957e3af1be04546436e874a60fe386041b244',
  };
  readonly engineVersion = '4.3.1';
  readonly inWorker = true;
  readonly decoding = 'greedy';
  readonly schemaMechanism = 'StructuredOutputProcessor logits processor 4.3.1';
  sameCheckpointAs: 'webllm' | null = 'webllm';
  readonly fallbacks: string[] = [];
  #client: WorkerClient | undefined;
  probe(): Promise<Availability> {
    return gpuProbe();
  }
  async load(progress: (loaded: number, total?: number) => void): Promise<LoadInfo> {
    this.#client = new WorkerClient(
      new Worker(new URL('./transformers.worker.ts', import.meta.url), { type: 'module' }),
    );
    const info = (await this.#client.load(progress)) as LoadInfo & {
      selected: ModelInfo;
      fallbacks: string[];
    };
    Object.assign(this.model, info.selected);
    this.fallbacks.push(...info.fallbacks.filter((id) => !this.fallbacks.includes(id)));
    this.sameCheckpointAs =
      this.model.id === 'onnx-community/Qwen2.5-1.5B-Instruct' ? 'webllm' : null;
    return { loadKind: info.loadKind, reportedBytes: info.reportedBytes };
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
