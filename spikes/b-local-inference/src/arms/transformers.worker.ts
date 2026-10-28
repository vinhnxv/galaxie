// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

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
serveWorker({
  async load(progress) {
    const fallbacks: string[] = [];
    for (const selected of candidates) {
      let downloaded = false;
      const sizes = new Map<string, number>();
      try {
        generator = await pipeline('text-generation', selected.id, {
          device: 'webgpu',
          dtype: 'q4f16',
          revision: selected.revision,
          progress_callback: (event) => {
            if (event.status === 'download') downloaded = true;
            if (event.status === 'progress') {
              sizes.set(event.file, event.total);
              progress(event.loaded, event.total);
            }
          },
        });
        return {
          loadKind: downloaded ? 'cold' : 'warm',
          reportedBytes: sizes.size ? [...sizes.values()].reduce((a, b) => a + b, 0) : null,
          selected,
          fallbacks,
        };
      } catch {
        await generator?.dispose();
        generator = undefined;
        fallbacks.push(selected.id);
      }
    }
    throw new Error('all_model_candidates_failed');
  },
  async generate(request, history, signal, emit) {
    const model = generator;
    if (!model) throw new Error('not_loaded');
    const stopping = new InterruptableStoppingCriteria();
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
      return { text, outputTokens, constrained: Boolean(processor), aborted: signal.aborted };
    } finally {
      signal.removeEventListener('abort', abort);
    }
  },
  async dispose() {
    await generator?.dispose();
    generator = undefined;
  },
});
