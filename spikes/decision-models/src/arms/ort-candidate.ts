// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { Availability, Profile, Reason } from '../results.js';
import {
  type Arm,
  ArmFailure,
  type DecisionReply,
  type DecisionRequest,
  type DedicatedId,
  type LoadRecord,
} from './types.js';
import { WorkerClient } from './worker-rpc.js';

export const missingContract: Record<DedicatedId, Reason> = {
  watersheep: 'watersheep_browser_packing_unknown',
  laya: 'laya_marker_contract_unknown',
  d1: 'd1_packing_decoding_not_ported',
};
export class OrtCandidate implements Arm {
  readonly id: DedicatedId;
  readonly profile: Profile;
  #client: WorkerClient | undefined;
  constructor(id: DedicatedId, profile: Profile) {
    this.id = id;
    this.profile = profile;
  }
  async probe(): Promise<Availability> {
    return !this.profile.webgpu.present
      ? { status: 'unavailable', reason: 'no_webgpu', raw: null }
      : !this.profile.webgpu.adapter
        ? { status: 'unavailable', reason: 'no_webgpu_adapter', raw: null }
        : { status: 'downloadable', reason: null, raw: null };
  }
  async load(progress: (loaded: number, total: number | null) => void): Promise<LoadRecord> {
    this.#client = new WorkerClient(
      new Worker(new URL('./ort-candidate.worker.ts', import.meta.url), { type: 'module' }),
    );
    return this.#client.call('load', this.id, undefined, progress);
  }
  async decide(_request: DecisionRequest, _signal: AbortSignal): Promise<DecisionReply> {
    throw new ArmFailure('inference_not_implemented');
  }
  async dispose(): Promise<void> {
    try {
      await this.#client?.call('dispose');
    } finally {
      this.#client?.terminate();
      this.#client = undefined;
    }
  }
}
