// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

/**
 * The most prompt tokens one model run takes. WebKit destroys the WebGPU device when a single run
 * keeps the GPU for about 3 s: on Safari 27.2 an unsplit prompt of about 2100 tokens does that for
 * Qwen3.5 0.8B q4, and less when other work shares the GPU. The same prompt in runs of 256 tokens
 * took 0.4 to 0.5 s per run on an idle GPU and 1.9 s on a busy one (docs/adk-recipes-real-model-record.md).
 */
export const prefillChunkTokens = 256;

/** The slice of a Transformers.js tensor that splitting a prompt needs. */
export interface PromptTensor {
  readonly dims: readonly number[];
  slice(...ranges: (null | readonly [number, number | null])[]): PromptTensor;
}

/** The tokenizer output for one prompt: a single sequence, so every mask entry is 1. */
export interface PromptInputs {
  readonly input_ids: PromptTensor;
  readonly attention_mask: PromptTensor;
}

/** The attention state of the tokens run so far, kept on the GPU for GPU models. */
export interface PromptCache {
  dispose(): Promise<void>;
}

export interface PrefillModel {
  generate(options: Record<string, unknown>): Promise<unknown>;
}

type PrepareInputs = (...args: unknown[]) => Record<string, unknown>;

/**
 * Lets `generate` run several prompt tokens on top of a cache. For Qwen vision-language classes
 * Transformers.js 4.3.2 sets `pixel_values` to null once a cache exists, and its forward treats
 * any present key as an image input whenever a run has more than one token, so a text-only model
 * with no vision session fails there. Dropping the null key gives the plain text run, and every
 * other input, including the rotary positions, stays the library's own.
 */
export function allowPromptOnCache(model: { prepare_inputs_for_generation?: PrepareInputs }): void {
  const prepare = model.prepare_inputs_for_generation;
  if (typeof prepare !== 'function') return;
  model.prepare_inputs_for_generation = (...args) => {
    const inputs = prepare.apply(model, args);
    if (inputs['pixel_values'] === null) delete inputs['pixel_values'];
    return inputs;
  };
}

/**
 * Runs all but the last `chunk` tokens of the prompt through the model in runs of `chunk` tokens
 * and returns the cache they leave. Passing that cache to `generate` with the whole prompt makes
 * the library run only the remaining tokens. A prompt of `chunk` tokens or fewer needs no cache.
 * The caller disposes the returned cache.
 */
export async function prefillInChunks(
  model: PrefillModel,
  inputs: PromptInputs,
  signal: AbortSignal,
  chunk: number = prefillChunkTokens,
): Promise<PromptCache | undefined> {
  const total = inputs.input_ids.dims[1] ?? 0;
  let cache: PromptCache | undefined;
  let done = 0;
  try {
    while (total - done > chunk) {
      signal.throwIfAborted();
      done += chunk;
      // One greedy token is sampled and dropped: `generate` is the library's only public way to
      // run a slice of a prompt on top of an existing cache and get the updated cache back.
      const result = (await model.generate({
        input_ids: inputs.input_ids.slice(null, [0, done]),
        attention_mask: inputs.attention_mask.slice(null, [0, done]),
        ...(cache === undefined ? {} : { past_key_values: cache }),
        max_new_tokens: 1,
        do_sample: false,
        return_dict_in_generate: true,
      })) as { readonly past_key_values: PromptCache };
      cache = result.past_key_values;
    }
  } catch (error) {
    await cache?.dispose().catch(() => undefined);
    throw error;
  }
  return cache;
}
