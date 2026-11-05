// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import mjs from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';
import wasm from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import { identityModel } from './identity-model.js';
import { emptyReport, type WorkerReport } from './report.js';
import { FILES, MODEL_ID, TOOL } from './tokenizer-files.js';

const violations: string[] = [];
function recordViolations(): void {
  self.addEventListener('securitypolicyviolation', (event) => {
    const { violatedDirective, blockedURI, sample } = event as SecurityPolicyViolationEvent;
    violations.push(`${violatedDirective}|${blockedURI}|${sample}`);
  });
}
recordViolations();

let functionConstructions = 0;
const NativeFunction = globalThis.Function;
globalThis.Function = new Proxy(NativeFunction, {
  construct(target, args, newTarget): object {
    functionConstructions += 1;
    return Reflect.construct(target, args, newTarget) as object;
  },
  apply(target, thisArg, args): unknown {
    functionConstructions += 1;
    return Reflect.apply(target, thisArg, args) as unknown;
  },
});

const message = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

async function probe(): Promise<WorkerReport> {
  const report = emptyReport();
  const { AutoTokenizer, env } = await import('@huggingface/transformers');
  const { InferenceSession, Tensor } = await import('onnxruntime-web/webgpu');

  if (!env.backends.onnx.wasm) throw new Error('The ONNX WASM environment is missing.');
  Object.assign(env.backends.onnx.wasm, {
    wasmPaths: {
      mjs: new URL(mjs, self.location.href).href,
      wasm: new URL(wasm, self.location.href).href,
    },
    numThreads: 1,
    proxy: false,
  });

  try {
    const session = await InferenceSession.create(identityModel(4), {
      executionProviders: ['wasm'],
    });
    const input = Float32Array.from([1, 2, 3, 4]);
    const result = await session.run({ input: new Tensor('float32', input, [4]) });
    report.identity = {
      input: [...input],
      output: [...((result['output']?.data as Float32Array | undefined) ?? [])],
    };
    await session.release();
  } catch (error) {
    report.failures['identity'] = message(error);
  }

  try {
    env.fetch = async () => {
      report.fetchCalls += 1;
      throw new Error('The verified model file is unavailable.');
    };
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = '/verified-models/';
    env.useBrowserCache = false;
    env.useFSCache = false;
    env.useCustomCache = true;
    env.useWasmCache = false;
    env.customCache = {
      async match(key) {
        report.requestedKeys.push(key);
        const prefix = `/verified-models/${MODEL_ID}/`;
        const name = key.startsWith(prefix) ? key.slice(prefix.length) : undefined;
        const body = name === undefined ? undefined : FILES[name];
        return body === undefined
          ? undefined
          : new Response(body, { headers: { 'content-type': 'application/json' } });
      },
      async put() {
        throw new Error('The verified model cache is read-only.');
      },
    };
    const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID, { local_files_only: true });
    const encoded = tokenizer('hello world') as { input_ids: { tolist(): number[][] | number[] } };
    const rendered = tokenizer.apply_chat_template(
      [{ role: 'user', content: 'what is the weather in paris' }],
      { tools: [TOOL], tokenize: false, add_generation_prompt: true },
    );
    report.tokenizer = {
      ids: JSON.parse(
        JSON.stringify(encoded.input_ids.tolist(), (_k, v: unknown) =>
          typeof v === 'bigint' ? Number(v) : v,
        ),
      ) as number[],
      rendered: String(rendered),
    };
  } catch (error) {
    report.failures['tokenizer'] = message(error);
  }

  try {
    // The constraint package is loaded the way the runtime loads it, then driven over a byte-level
    // vocabulary: the logits favor `z` at every step, so only the mask can produce valid output.
    const { StructuredOutputProcessor } = await import(
      '@huggingface/transformers-structured-output'
    );
    const tokens = Array.from({ length: 256 }, (_, byte) => Uint8Array.of(byte));
    tokens.push(new Uint8Array(0));
    const processor = new StructuredOutputProcessor(
      { tokens, eosTokenId: 256 },
      {
        type: 'json_schema',
        json_schema: {
          type: 'object',
          properties: { a: { type: 'integer' } },
          required: ['a'],
          additionalProperties: false,
        },
      },
    );
    const input: bigint[] = [];
    let text = '';
    for (let step = 0; step < 64; step++) {
      const data = new Float32Array(257);
      data[0x7a] = 10;
      processor._call([input], { dims: [1, 257], data } as never);
      let best = 0;
      for (let id = 1; id < data.length; id++) if ((data[id] ?? 0) > (data[best] ?? 0)) best = id;
      if (best === 256) break;
      input.push(BigInt(best));
      text += String.fromCharCode(best);
    }
    report.constrained = text;
  } catch (error) {
    report.failures['constrained'] = message(error);
  }
  return report;
}

probe()
  .catch(
    (error: unknown): WorkerReport => ({
      identity: undefined,
      tokenizer: undefined,
      constrained: undefined,
      failures: { load: message(error) },
      violations: [],
      functionConstructions: 0,
      fetchCalls: 0,
      requestedKeys: [],
    }),
  )
  // Violation events are queued as tasks; wait so late ones are included.
  .then((report) => new Promise<WorkerReport>((resolve) => setTimeout(() => resolve(report), 100)))
  .then((report) => {
    self.postMessage({ ...report, violations: [...violations], functionConstructions });
  });
