// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';
import { transformersRuntime } from '../src/transformers/runtime.js';
import { createSyntheticModel } from './support/transformers-model.js';

// A stand-in for the library: only the calls the real runtime makes, recording what generation
// receives. The constraint package is the real one, so the processor is real.
const library = vi.hoisted(() => ({ generations: [] as Record<string, unknown>[] }));

vi.mock('@huggingface/transformers', () => {
  const tokens = [
    ...Array.from({ length: 256 }, (_, byte) => Uint8Array.of(byte)),
    new Uint8Array(0),
  ];
  return {
    env: { backends: { onnx: { wasm: {} } } },
    AutoTokenizer: {
      from_pretrained: async () => ({
        tokens,
        eosTokenId: 256,
        apply_chat_template: () => ({ input_ids: { dims: [1, 5] } }),
      }),
    },
    AutoModelForCausalLM: {
      from_pretrained: async () => ({
        generate: async (options: Record<string, unknown>) => {
          library.generations.push(options);
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

describe('the real runtime with a schema', () => {
  it('builds one processor per request and passes it to generation only when a schema is set', async () => {
    const { record } = await createSyntheticModel();
    const loaded = await transformersRuntime.load({
      record,
      cache: { match: async () => undefined, put: async () => undefined } as never,
      assets: { mjs: 'ort.mjs', wasm: 'ort.wasm' },
    });
    const request = {
      messages: [{ role: 'user' as const, content: 'hello' }],
      maxTokens: 8,
      temperature: 0,
    };
    const generate = (extra: object = {}) =>
      loaded.generate({
        request: { ...request, ...extra },
        contextWindow: 4096,
        onText: () => undefined,
        signal: new AbortController().signal,
      });
    const schema = { type: 'object', properties: { a: { type: 'integer' } }, required: ['a'] };
    await generate({ jsonSchema: schema });
    await generate({ jsonSchema: schema });
    await generate();
    const [first, second, plain] = library.generations;
    expect(first?.['logits_processor']).toBeDefined();
    expect(second?.['logits_processor']).toBeDefined();
    // State lives in the processor, so a request must never reuse another's.
    expect(second?.['logits_processor']).not.toBe(first?.['logits_processor']);
    expect(plain).not.toHaveProperty('logits_processor');
    await loaded.dispose();
  });
});
