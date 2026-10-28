// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { gpuProbe } from '../../device.js';
import type { Arm, Availability, LoadInfo, Session } from '../types.js';
import { EngineClient } from './client.js';
import { TOTAL_DOWNLOAD_BYTES } from './model-files.js';
import type { JsonSchema } from './protocol.js';
export class OrtArm implements Arm {
  readonly id = 'ort-own-loop';
  readonly model = {
    id: 'LiquidAI/LFM3-1.7B-ONNX',
    revision: '189271ef61b9e7fdd4a8b5b0891bcacad37700f8',
  };
  readonly engineVersion = '1.31.0-dev.20260914-8d85527a0';
  readonly inWorker = true;
  readonly decoding = 'greedy';
  readonly schemaMechanism = 'copied JSON guide during decoding';
  readonly sameCheckpointAs = null;
  #client: EngineClient | undefined;
  probe(): Promise<Availability> {
    return gpuProbe();
  }
  async load(progress: (loaded: number, total?: number) => void): Promise<LoadInfo> {
    this.#client = new EngineClient();
    const info = await this.#client.load((value) =>
      progress(value.loadedBytes ?? 0, value.totalBytes),
    );
    return {
      loadKind: info.downloadedFiles.length ? 'cold' : 'warm',
      reportedBytes: TOTAL_DOWNLOAD_BYTES,
    };
  }
  async openSession(): Promise<Session> {
    const client = this.#client;
    if (!client) throw new Error('not_loaded');
    const id = await client.openSession();
    return {
      generate: async (request) => {
        const result = await client.generate(
          id,
          {
            messages: request.messages,
            maxNewTokens: request.maxTokens,
            ...(request.schema ? { jsonSchema: request.schema as JsonSchema } : {}),
          },
          request.onChunk,
          request.signal,
        );
        return {
          text: result.text,
          outputTokens: result.stats.newTokens,
          ...(request.schema
            ? {
                forcedTokens: result.stats.forcedTokens ?? 0,
                modelChosenTokens: result.stats.newTokens - (result.stats.forcedTokens ?? 0),
              }
            : {}),
          constrained: Boolean(request.schema),
          executedIn: result.executedIn,
          aborted: result.stats.aborted,
        };
      },
      close: () => client.closeSession(id),
    };
  }
  async dispose(): Promise<void> {
    await this.#client?.dispose();
    this.#client = undefined;
  }
}
