// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';
import {
  allowPromptOnCache,
  type PromptCache,
  type PromptInputs,
  type PromptTensor,
  prefillChunkTokens,
  prefillInChunks,
} from '../src/transformers/prefill.js';
import { transformersRuntime } from '../src/transformers/runtime.js';
import { createSyntheticModel } from './support/transformers-model.js';

/** A one-row token tensor that supports the `slice(null, [start, end])` the prefill uses. */
function tensor(length: number): PromptTensor {
  return {
    dims: [1, length],
    slice: (_rows, range) => tensor((range?.[1] ?? length) - (range?.[0] ?? 0)),
  };
}

function prompt(length: number): PromptInputs {
  return { input_ids: tensor(length), attention_mask: tensor(length) };
}

function fakeCache(): PromptCache & { disposed: number } {
  return {
    disposed: 0,
    async dispose(): Promise<void> {
      this.disposed += 1;
    },
  };
}

/** A model whose `generate` hands back the one cache it owns, as the library does. */
function fakeModel(cache: PromptCache = fakeCache()): {
  readonly calls: Record<string, unknown>[];
  readonly cache: PromptCache;
  generate(options: Record<string, unknown>): Promise<unknown>;
} {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    cache,
    async generate(options) {
      calls.push(options);
      return { past_key_values: cache };
    },
  };
}

const lengthOf = (value: unknown): number | undefined => (value as PromptTensor).dims[1];

describe('prefillInChunks', () => {
  it('runs a prompt of at most one chunk in the final generation and builds no cache', async () => {
    const model = fakeModel();
    for (const length of [0, 1, 7, 8]) {
      expect(await prefillInChunks(model, prompt(length), new AbortController().signal, 8)).toBe(
        undefined,
      );
    }
    expect(model.calls).toEqual([]);
  });

  it('leaves between one and chunk tokens for the final generation', async () => {
    const lengths = (total: number): Promise<number[]> => {
      const model = fakeModel();
      return prefillInChunks(model, prompt(total), new AbortController().signal, 8).then(() =>
        model.calls.map((call) => lengthOf(call['input_ids']) ?? 0),
      );
    };
    expect(await lengths(9)).toEqual([8]);
    expect(await lengths(16)).toEqual([8]);
    expect(await lengths(17)).toEqual([8, 16]);
    expect(await lengths(100)).toEqual(Array.from({ length: 12 }, (_, run) => 8 * (run + 1)));
  });

  it('extends one cache across the runs and samples one greedy token it drops', async () => {
    const model = fakeModel();
    const cache = await prefillInChunks(model, prompt(20), new AbortController().signal, 8);
    expect(cache).toBe(model.cache);
    expect(model.calls).toHaveLength(2);
    expect(model.calls[0]).not.toHaveProperty('past_key_values');
    expect(model.calls[1]?.['past_key_values']).toBe(model.cache);
    for (const call of model.calls) {
      expect(call).toMatchObject({
        max_new_tokens: 1,
        do_sample: false,
        return_dict_in_generate: true,
      });
      expect(lengthOf(call['attention_mask'])).toBe(lengthOf(call['input_ids']));
    }
    expect(await prefillInChunks(model, prompt(5), new AbortController().signal, 8)).toBe(
      undefined,
    );
  });

  it('defaults to 256-token runs', async () => {
    expect(prefillChunkTokens).toBe(256);
    const model = fakeModel();
    await prefillInChunks(model, prompt(600), new AbortController().signal);
    expect(model.calls.map((call) => lengthOf(call['input_ids']))).toEqual([256, 512]);
  });

  it('disposes the cache and rethrows when a run fails', async () => {
    const cache = fakeCache();
    let calls = 0;
    const model = {
      async generate(): Promise<unknown> {
        calls += 1;
        if (calls === 2) throw new Error('device lost');
        return { past_key_values: cache };
      },
    };
    await expect(
      prefillInChunks(model, prompt(40), new AbortController().signal, 8),
    ).rejects.toThrow('device lost');
    expect(cache.disposed).toBe(1);
  });

  it('stops between runs when aborted and disposes what it built', async () => {
    const cache = fakeCache();
    const controller = new AbortController();
    const model = {
      calls: 0,
      async generate(): Promise<unknown> {
        this.calls += 1;
        controller.abort();
        return { past_key_values: cache };
      },
    };
    await expect(prefillInChunks(model, prompt(40), controller.signal, 8)).rejects.toThrow();
    expect(model.calls).toBe(1);
    expect(cache.disposed).toBe(1);
  });
});

describe('allowPromptOnCache', () => {
  function fakeLibraryModel(prepared: Record<string, unknown>): {
    prepare_inputs_for_generation?: (...args: unknown[]) => Record<string, unknown>;
    seen: unknown[][];
  } {
    const seen: unknown[][] = [];
    return {
      seen,
      prepare_inputs_for_generation(...args) {
        seen.push(args);
        return prepared;
      },
    };
  }

  it('drops a null pixel_values and keeps every other input the library prepared', () => {
    const model = fakeLibraryModel({ pixel_values: null, position_ids: 'p', rope_deltas: 'r' });
    allowPromptOnCache(model);
    expect(model.prepare_inputs_for_generation?.(1, 2, 3)).toEqual({
      position_ids: 'p',
      rope_deltas: 'r',
    });
    expect(model.seen).toEqual([[1, 2, 3]]);
  });

  it('leaves real pixel_values and models without the method alone', () => {
    const images = { pixel_values: { dims: [1] } };
    const model = fakeLibraryModel(images);
    allowPromptOnCache(model);
    expect(model.prepare_inputs_for_generation?.()).toBe(images);
    const bare: { prepare_inputs_for_generation?: never } = {};
    allowPromptOnCache(bare);
    expect(bare.prepare_inputs_for_generation).toBeUndefined();
  });
});

// A stand-in for the library: the tokenizer returns a prompt of the length the test sets.
const library = vi.hoisted(() => ({
  promptLength: 5,
  calls: [] as Record<string, unknown>[],
  cache: { disposed: 0 },
}));

vi.mock('@huggingface/transformers', () => {
  const tensorOf = (length: number): unknown => ({
    dims: [1, length],
    slice: (_rows: unknown, range: readonly [number, number | null]) =>
      tensorOf((range[1] ?? length) - range[0]),
  });
  return {
    env: { backends: { onnx: { wasm: {} } } },
    AutoTokenizer: {
      from_pretrained: async () => ({
        apply_chat_template: () => ({
          input_ids: tensorOf(library.promptLength),
          attention_mask: tensorOf(library.promptLength),
        }),
      }),
    },
    AutoModelForCausalLM: {
      from_pretrained: async () => ({
        prepare_inputs_for_generation: () => ({ pixel_values: null }),
        generate: async (options: Record<string, unknown>) => {
          library.calls.push(options);
          return { past_key_values: library.cache };
        },
        dispose: async () => undefined,
      }),
    },
    TextStreamer: class {},
    InterruptableStoppingCriteria: class {
      interrupt(): void {}
    },
  };
});

describe('the real runtime with a long prompt', () => {
  async function run(promptLength: number): Promise<void> {
    library.promptLength = promptLength;
    library.calls.length = 0;
    library.cache.disposed = 0;
    Object.assign(library.cache, {
      dispose: async () => {
        library.cache.disposed += 1;
      },
    });
    const { record } = await createSyntheticModel();
    const loaded = await transformersRuntime.load({
      record,
      cache: { match: async () => undefined, put: async () => undefined } as never,
      assets: { mjs: 'ort.mjs', wasm: 'ort.wasm' },
    });
    await loaded.generate({
      request: { messages: [{ role: 'user', content: 'hi' }], maxTokens: 8, temperature: 0 },
      contextWindow: 4096,
      onText: () => undefined,
      signal: new AbortController().signal,
    });
    await loaded.dispose();
  }

  it('generates in one call for a prompt of one chunk or less', async () => {
    await run(prefillChunkTokens);
    expect(library.calls).toHaveLength(1);
    expect(library.calls[0]).not.toHaveProperty('past_key_values');
    expect(library.cache.disposed).toBe(0);
  });

  it('prefills in slices, generates the rest on the cache and disposes it once', async () => {
    await run(600);
    expect(library.calls.map((call) => lengthOf(call['input_ids']))).toEqual([256, 512, 600]);
    const last = library.calls[2];
    expect(last?.['past_key_values']).toBe(library.cache);
    expect(last).toMatchObject({ max_new_tokens: 8 });
    expect(last).not.toHaveProperty('return_dict_in_generate');
    expect(library.cache.disposed).toBe(1);
  });
});
