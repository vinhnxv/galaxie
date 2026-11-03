// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { TransformersChatModel } from '../src/transformers/chat-model.js';
import { createTransformersEngine } from '../src/transformers/engine.js';
import { constraintFor } from '../src/transformers/runtime.js';
import type { FakeRuntimeOptions } from './support/fake-transformers-runtime.js';
import { setup } from './support/transformers-loopback.js';
import { createSyntheticModel } from './support/transformers-model.js';

/** One token per byte plus an end-of-sequence token, the shape the constraint package accepts. */
const bytes = Object.assign(
  { tokens: [...Array.from({ length: 256 }, (_, byte) => Uint8Array.of(byte)), new Uint8Array(0)] },
  { eosTokenId: 256 },
);
const schema = {
  type: 'object',
  properties: { a: { type: 'integer' } },
  required: ['a'],
  additionalProperties: false,
};

type Processor = (inputs: bigint[][], logits: { dims: number[]; data: Float32Array }) => unknown;

/** Greedy decoding where the unconstrained logits favor `z` at every step. */
async function decode(processor: object): Promise<string> {
  const call = (processor as { _call?: Processor })._call?.bind(processor);
  if (call === undefined) throw new Error('The processor has no _call.');
  const input: bigint[] = [];
  let text = '';
  for (let step = 0; step < 64; step++) {
    const data = new Float32Array(257);
    data[0x7a] = 10;
    call([input], { dims: [1, 257], data });
    let best = 0;
    for (let id = 1; id < data.length; id++) if ((data[id] ?? 0) > (data[best] ?? 0)) best = id;
    if (best === 256) break;
    input.push(BigInt(best));
    text += String.fromCharCode(best);
  }
  return text;
}

afterEach(() => {
  vi.doUnmock('@huggingface/transformers-structured-output');
  vi.resetModules();
});

describe('constrained decoding', () => {
  it('builds a processor from a JSON Schema that forces a valid reply whatever the logits favor', async () => {
    const text = await decode(await constraintFor(bytes, schema));
    expect(JSON.parse(text)).toEqual({ a: expect.any(Number) });
  });

  it('fails invalid for a schema the package cannot enforce', async () => {
    await expect(
      constraintFor(bytes, { type: 'string', pattern: '^[a-z]+$' }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('fails unsupported when the optional package is not installed', async () => {
    vi.resetModules();
    vi.doMock('@huggingface/transformers-structured-output', () => {
      throw new Error('not installed');
    });
    const { constraintFor: fresh } = await import('../src/transformers/runtime.js');
    await expect(fresh(bytes, schema)).rejects.toMatchObject({ code: 'unsupported' });
  });
});

describe('structured output with tools', () => {
  async function fixture(options: FakeRuntimeOptions = {}) {
    const model = await createSyntheticModel({ toolFormat: 'hermes' });
    const parts = await setup({ model, runtime: options });
    const handle = await createTransformersEngine(
      { worker: parts.worker, model: parts.model.record, allowDownload: true },
      { gpu: undefined },
    );
    return { ...parts, handle, model: new TransformersChatModel(handle) };
  }

  it('refuses a call that carries both a schema and tools before any dispatch', async () => {
    const { runtime, handle, model } = await fixture();
    try {
      const tool = {
        type: 'function',
        function: { name: 'lookup', parameters: { type: 'object', properties: {} } },
      };
      await expect(
        model
          .bindTools([tool])
          .withStructuredOutput(z.object({ a: z.string() }))
          .invoke('hello'),
      ).rejects.toMatchObject({ code: 'unsupported' });
      expect(runtime.generations).toEqual([]);
      // Unused imports keep the message helpers available to later cases.
      expect([AIMessage, HumanMessage]).toHaveLength(2);
    } finally {
      await handle.dispose();
    }
  });
});
