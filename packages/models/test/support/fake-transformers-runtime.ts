// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { ModelError } from '../../src/errors.js';
import type {
  LoadedRuntime,
  RuntimeGenerateOptions,
  RuntimeGenerateResult,
  RuntimeLoadOptions,
  TransformersRuntime,
} from '../../src/transformers/runtime.js';
import { readBytes } from './transformers-model.js';

export interface FakeRuntimeOptions {
  /** Text pieces each generation emits, one per step. */
  readonly pieces?: readonly string[];
  /** Pieces per generation, in order; the last script repeats. Overrides `pieces` when set. */
  readonly scripts?: readonly (readonly string[])[];
  /** After this many pieces the first generation waits for an abort; later ones run to the end. */
  readonly holdAfter?: number;
  /** The load rejects with this error. */
  readonly loadError?: unknown;
  /** The generation rejects with this error before emitting. */
  readonly generateError?: unknown;
  readonly backend?: 'webgpu' | 'wasm';
  /** Prompt length the fake reports; with `maxTokens` it is checked against the context window. */
  readonly promptTokens?: number;
  /** The finish reason a generation that ran to the end reports; `stop` by default. */
  readonly finishReason?: 'stop' | 'length';
}

export interface FakeRuntime extends TransformersRuntime {
  readonly loads: RuntimeLoadOptions[];
  readonly generations: RuntimeGenerateOptions[];
  /** File bytes the runtime read through the verified cache during load, keyed by record path. */
  readonly read: Map<string, Uint8Array>;
  disposed: number;
}

export function createFakeRuntime(options: FakeRuntimeOptions = {}): FakeRuntime {
  const pieces = options.pieces ?? ['Hello', ' world'];
  const runtime: FakeRuntime = {
    loads: [],
    generations: [],
    read: new Map(),
    disposed: 0,
    async load(load): Promise<LoadedRuntime> {
      runtime.loads.push(load);
      for (const file of load.record.files) {
        const bytes = await readBytes(
          await load.cache.match(`/verified-models/${load.record.modelId}/${file.path}`),
        );
        runtime.read.set(file.path, bytes);
      }
      if (options.loadError !== undefined) throw options.loadError;
      return {
        device: {
          backend: options.backend ?? load.record.device,
          thread: 'worker',
          vendor: 'fake',
          architecture: 'fake',
        },
        async generate(generation): Promise<RuntimeGenerateResult> {
          runtime.generations.push(generation);
          if (options.generateError !== undefined) throw options.generateError;
          const promptTokens = options.promptTokens ?? 5;
          if (promptTokens + generation.request.maxTokens > generation.contextWindow)
            throw new ModelError('invalid');
          const first = runtime.generations.length === 1;
          const script =
            options.scripts?.[runtime.generations.length - 1] ?? options.scripts?.at(-1);
          let emitted = 0;
          for (const piece of script ?? pieces) {
            if (generation.signal.aborted) break;
            if (first && options.holdAfter !== undefined && emitted >= options.holdAfter) {
              await new Promise<void>((resolve) => {
                if (generation.signal.aborted) resolve();
                generation.signal.addEventListener('abort', () => resolve(), { once: true });
              });
              break;
            }
            generation.onText(piece);
            emitted += 1;
            await Promise.resolve();
          }
          return {
            promptTokens,
            completionTokens: emitted,
            finishReason: generation.signal.aborted ? 'abort' : (options.finishReason ?? 'stop'),
          };
        },
        async dispose(): Promise<void> {
          runtime.disposed += 1;
        },
      };
    },
  };
  return runtime;
}
