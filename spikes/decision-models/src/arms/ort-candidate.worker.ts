// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import wasmModule from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';
import wasmBinary from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
// Session/external-data setup adapted from spikes/b-local-inference/src/arms/ort/worker.ts.
// Local WASM routing follows spikes/b-local-inference/src/arms/transformers.worker.ts.
import * as ort from 'onnxruntime-web/webgpu';
import { type FileVerification, inventory, type RuntimeDump } from '../results.js';
import { digest, fetchVerified } from './fetch-verified.js';
import { ArmFailure, type DedicatedId, type LoadRecord } from './types.js';
import { serveWorker } from './worker-rpc.js';

ort.env.wasm.wasmPaths = { mjs: wasmModule, wasm: wasmBinary };
ort.env.wasm.numThreads = 1;
let session: ort.InferenceSession | undefined;
const inventoryIds = { watersheep: 'watersheep-0.1.0', laya: 'laya-english-q4', d1: 'd1-2b-onnx' };
function metadata(value: unknown): RuntimeDump['inputMetadata'] {
  if (!Array.isArray(value)) return null;
  return value.map((item: unknown) => {
    const object = typeof item === 'object' && item !== null ? item : {};
    const dimensions: unknown = Reflect.get(object, 'shape') ?? Reflect.get(object, 'dimensions');
    return {
      name: String(Reflect.get(object, 'name') ?? ''),
      type:
        typeof Reflect.get(object, 'type') === 'string'
          ? String(Reflect.get(object, 'type'))
          : null,
      dimensions: Array.isArray(dimensions)
        ? dimensions.map((dimension: unknown) =>
            typeof dimension === 'number' || typeof dimension === 'string' ? dimension : null,
          )
        : [],
    };
  });
}
serveWorker({
  async load(value, progress): Promise<LoadRecord> {
    const id = value as DedicatedId;
    const entry = inventory.find((candidate) => candidate.id === inventoryIds[id]);
    if (!entry) throw new ArmFailure('load_failed');
    const files: FileVerification[] = [];
    const buffers = new Map<string, Uint8Array<ArrayBuffer>>();
    let downloadMs = 0;
    try {
      for (const file of entry.files) {
        const loaded = await fetchVerified(entry, file, progress);
        files.push(loaded.verification);
        buffers.set(file.path, loaded.bytes);
        downloadMs += loaded.downloadMs;
      }
      let graph: Uint8Array<ArrayBuffer>;
      if (id === 'laya') {
        const manifest = entry.assembly;
        if (!manifest) throw new ArmFailure('file_mismatch');
        const parts = entry.files.filter((file) => file.role === 'model-part');
        const total = parts.reduce(
          (sum, file) => sum + (buffers.get(file.path)?.byteLength ?? 0),
          0,
        );
        if (total !== manifest.total_bytes) throw new ArmFailure('file_mismatch');
        graph = new Uint8Array(total);
        let offset = 0;
        for (const part of parts) {
          const bytes = buffers.get(part.path);
          if (!bytes) throw new ArmFailure('file_mismatch');
          graph.set(bytes, offset);
          offset += bytes.byteLength;
        }
        const computedDigest = await digest(graph, 'sha256');
        files.push({
          path: 'english/model.q4.onnx',
          status: computedDigest === manifest.sha256 ? 'verified' : 'mismatch',
          actualBytes: graph.byteLength,
          computedDigest,
          downloaded: false,
        });
        if (computedDigest !== manifest.sha256) throw new ArmFailure('file_mismatch');
      } else {
        const path = entry.files.find((file) => file.role === 'graph')?.path;
        const bytes = path ? buffers.get(path) : undefined;
        if (!bytes) throw new ArmFailure('file_mismatch');
        graph = bytes;
      }
      const externalData =
        id === 'd1'
          ? [
              {
                path: 'decoder_q4f16.onnx_data',
                data: buffers.get('onnx/decoder_q4f16.onnx_data') as Uint8Array<ArrayBuffer>,
              },
            ]
          : [];
      const start = performance.now();
      session = await ort.InferenceSession.create(graph, {
        executionProviders: ['webgpu'],
        externalData,
      });
      const dump: RuntimeDump = {
        inputNames: [...session.inputNames],
        outputNames: [...session.outputNames],
        inputMetadata: metadata(Reflect.get(session, 'inputMetadata')),
        outputMetadata: metadata(Reflect.get(session, 'outputMetadata')),
      };
      return {
        downloadMs: files.some((file) => file.downloaded) ? downloadMs : null,
        downloadReason: files.some((file) => file.downloaded) ? null : 'already_cached',
        loadMs: performance.now() - start,
        files,
        runtime: dump,
      };
    } catch (error) {
      if (session) {
        await session.release();
        session = undefined;
      }
      const failure = error instanceof ArmFailure ? error : new ArmFailure('load_failed');
      throw new ArmFailure(failure.reason, [...files, ...failure.files]);
    }
  },
  async decide(): Promise<never> {
    throw new ArmFailure('inference_not_implemented');
  },
  async dispose(): Promise<void> {
    await session?.release();
    session = undefined;
  },
});
