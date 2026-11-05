// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  env,
  InterruptableStoppingCriteria,
  pipeline,
  type TextGenerationPipeline,
  TextStreamer,
} from '@huggingface/transformers';
import {
  type ResponseFormat,
  StructuredOutputProcessor,
} from '@huggingface/transformers-structured-output';
import mjs from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';
import wasm from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import type { ModelInfo } from './types.js';
import { serveWorker } from './worker-rpc.js';

// Both arms resolve the identical ORT pin. The factory must stay on this origin under script-src self.
const wasmBackend = env.backends.onnx.wasm;
if (!wasmBackend) throw new Error('onnx_wasm_backend_missing');
wasmBackend.wasmPaths = { wasm, mjs };
wasmBackend.numThreads = 1;
env.useWasmCache = false;
env.allowLocalModels = false;
const candidates = [
  {
    id: 'onnx-community/Qwen2.5-1.5B-Instruct',
    revision: 'd54957e3af1be04546436e874a60fe386041b244',
  },
  {
    id: 'onnx-community/Qwen2.5-0.5B-Instruct',
    revision: '22942cb7d7ba4cc81bb4673549ca4d4614469b5e',
  },
  { id: 'onnx-community/LFM2-1.2B-ONNX', revision: 'dd095948cf23919ef2fcb635a156ce59975f35ff' },
];
let generator: TextGenerationPipeline | undefined;
// Error name plus a short message, so a CSP block, a network error or an unsupported model can be
// told apart; model text never reaches these messages.
function errorClass(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message.slice(0, 160)}` : 'unknown';
}
serveWorker({
  async load(progress) {
    const fallbacks: string[] = [];
    const causes: string[] = [];
    const { pinned, dtype } = JSON.parse(self.name) as {
      pinned: ModelInfo | null;
      dtype: 'q4f16' | 'q4';
    };
    const models = pinned
      ? candidates.filter((model) => model.id === pinned.id && model.revision === pinned.revision)
      : candidates;
    let reads = 0;
    let writes = 0;
    let cacheObserved = false;
    env.useCustomCache = false;
    try {
      const cache = await caches.open(env.cacheKey);
      const match = cache.match.bind(cache);
      const put = cache.put.bind(cache);
      cache.match = async (...args) => {
        const response = await match(...args);
        if (response) reads++;
        return response;
      };
      cache.put = async (...args) => {
        writes++;
        await put(...args);
      };
      // Transformers.js checks the native Cache type when deciding which keys may be stored.
      env.customCache = cache;
      env.useCustomCache = true;
      cacheObserved = true;
    } catch {
      /* Cache state remains unknown; the library retains its default fallback path. */
    }
    for (const selected of models) {
      const sizes = new Map<string, number>();
      try {
        generator = await pipeline('text-generation', selected.id, {
          device: 'webgpu',
          dtype,
          revision: selected.revision,
          progress_callback: (event) => {
            if (event.status === 'progress') {
              sizes.set(event.file, event.total);
              progress(event.loaded, event.total);
            }
          },
        });
        return {
          loadKind: cacheObserved && writes ? 'cold' : cacheObserved && reads ? 'warm' : 'unknown',
          ...(!cacheObserved || (!reads && !writes) ? { reason: 'cache_state_unknown' } : {}),
          reportedBytes: sizes.size ? [...sizes.values()].reduce((a, b) => a + b, 0) : null,
          selected,
          fallbacks,
        };
      } catch (error) {
        await generator?.dispose();
        generator = undefined;
        fallbacks.push(selected.id);
        causes.push(`${selected.id}: ${errorClass(error)}`);
      }
    }
    throw new Error(`all_model_candidates_failed (${causes.join('; ')})`);
  },
  async generate(request, history, signal, emit) {
    const model = generator;
    if (!model) throw new Error('not_loaded');
    const stopping = new InterruptableStoppingCriteria();
    let stopObserved = false;
    const stop = stopping._call.bind(stopping);
    stopping._call = (ids, scores) => {
      const decision = stop(ids, scores);
      if (decision.some(Boolean)) stopObserved = true;
      return decision;
    };
    const abort = (): void => stopping.interrupt();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    let outputTokens = 0;
    const streamer = new TextStreamer(model.tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (text) => {
        if (text) emit(text);
      },
      token_callback_function: (tokens) => {
        outputTokens += tokens.length;
      },
    });
    try {
      const processor = request.schema
        ? new StructuredOutputProcessor(model.tokenizer, {
            type: 'json_schema',
            json_schema: request.schema,
          } as Extract<ResponseFormat, { type: 'json_schema' }>)
        : undefined;
      const output = await model([...history, ...request.messages], {
        max_new_tokens: request.maxTokens,
        do_sample: false,
        streamer,
        stopping_criteria: [stopping],
        return_full_text: false,
        ...(processor ? { logits_processor: processor } : {}),
      });
      const generated = output[0]?.generated_text;
      const text = typeof generated === 'string' ? generated : generated?.at(-1)?.content;
      if (typeof text !== 'string') throw new Error('unexpected_generation_shape');
      return { text, outputTokens, constrained: Boolean(processor), aborted: stopObserved };
    } finally {
      signal.removeEventListener('abort', abort);
    }
  },
  async dispose() {
    await generator?.dispose();
    generator = undefined;
  },
});
