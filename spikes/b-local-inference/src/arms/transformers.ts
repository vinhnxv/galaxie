// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { gpuProbe } from '../device.js';
import type { Arm, Availability, LoadInfo, ModelInfo, Session } from './types.js';
import { WorkerClient } from './worker-rpc.js';
export type TransformersDtype = 'q4f16' | 'q4';
export class TransformersArm implements Arm {
  readonly id = 'transformers-js';
  readonly model: ModelInfo & { dtype: TransformersDtype };
  // q4f16 is the planned default; q4 keeps fp32 activations, for checkpoints whose fp16
  // activations overflow on a device.
  constructor(dtype: TransformersDtype = 'q4f16') {
    this.model = {
      id: 'onnx-community/Qwen2.5-1.5B-Instruct',
      revision: 'd54957e3af1be04546436e874a60fe386041b244',
      dtype,
    };
  }
  readonly engineVersion = '4.3.1';
  readonly inWorker = true;
  readonly decoding = 'greedy';
  readonly schemaMechanism = 'StructuredOutputProcessor logits processor 4.3.1';
  sameCheckpointAs: 'webllm' | null = 'webllm';
  readonly fallbacks: string[] = [];
  #client: WorkerClient | undefined;
  #selected = false;
  probe(): Promise<Availability> {
    return gpuProbe();
  }
  async load(progress: (loaded: number, total?: number) => void): Promise<LoadInfo> {
    this.#client = new WorkerClient(
      new Worker(new URL('./transformers.worker.ts', import.meta.url), {
        type: 'module',
        name: JSON.stringify({
          pinned: this.#selected ? this.model : null,
          dtype: this.model.dtype,
        }),
      }),
    );
    const info = (await this.#client.load(progress)) as LoadInfo & {
      selected: ModelInfo;
      fallbacks: string[];
    };
    if (
      this.#selected &&
      (info.selected.id !== this.model.id || info.selected.revision !== this.model.revision)
    )
      throw new Error('checkpoint_changed');
    Object.assign(this.model, info.selected);
    this.#selected = true;
    this.fallbacks.push(...info.fallbacks.filter((id) => !this.fallbacks.includes(id)));
    this.sameCheckpointAs =
      this.model.id === 'onnx-community/Qwen2.5-1.5B-Instruct' ? 'webllm' : null;
    return {
      loadKind: info.loadKind,
      reportedBytes: info.reportedBytes,
      ...(info.reason === undefined ? {} : { reason: info.reason }),
    };
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
