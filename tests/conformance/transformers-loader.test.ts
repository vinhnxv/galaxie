// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import { createTransformersEngine } from '../../packages/models/src/transformers/engine.js';
import type { GenerateRequest } from '../../packages/models/src/transformers/protocol.js';
import { createWorkerHost } from '../../packages/models/src/transformers/worker-host.js';
import { createFakeRuntime } from '../../packages/models/test/support/fake-transformers-runtime.js';
import {
  createFakeFetch,
  createSyntheticModel,
  MemoryStore,
} from '../../packages/models/test/support/transformers-model.js';

const request: GenerateRequest = {
  messages: [{ role: 'user', content: 'hello' }],
  maxTokens: 16,
  temperature: 0,
};

/** Node has no Worker global, so the same host runs behind a structured-clone loopback there. */
function nodeWorker(model: Awaited<ReturnType<typeof createSyntheticModel>>) {
  const worker = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    onerror: null,
    onmessageerror: null,
    terminated: 0,
    postMessage(message: unknown): void {
      const copy = structuredClone(message);
      queueMicrotask(() => host.receive(copy));
    },
    terminate(): void {
      worker.terminated += 1;
    },
  };
  const host = createWorkerHost({
    post: (message) => {
      const copy = structuredClone(message);
      queueMicrotask(() => worker.onmessage?.({ data: copy } as MessageEvent));
    },
    runtime: createFakeRuntime({ pieces: ['Hello', ' from', ' a worker'] }),
    assets: { mjs: 'https://app.test/ort.mjs', wasm: 'https://app.test/ort.wasm' },
    openStore: async () => new MemoryStore(),
    fetch: createFakeFetch(model.served).fetch,
  });
  return worker;
}

test('a worker loads verified files and streams a generation over postMessage', async () => {
  const model = await createSyntheticModel({ modelId: 'example-org/tiny-fixture' });
  const worker =
    typeof Worker === 'undefined'
      ? nodeWorker(model)
      : new Worker(
          new URL(
            '../../packages/models/test/support/transformers-worker-entry.ts',
            import.meta.url,
          ),
          { type: 'module' },
        );
  const phases: string[] = [];
  const handle = await createTransformersEngine(
    {
      worker,
      model: model.record,
      allowDownload: true,
      onProgress: (progress) => phases.push(progress.phase),
    },
    { gpu: undefined },
  );
  try {
    expect(phases[0]).toBe('download');
    expect(phases.at(-1)).toBe('load');
    expect(handle.device.backend).toBe('wasm');
    const text: string[] = [];
    let finish: unknown;
    for await (const event of handle.stream(request)) {
      if (event.type === 'chunk') text.push(event.text);
      else finish = event;
    }
    expect(text.join('')).toBe('Hello from a worker');
    expect(finish).toEqual({
      type: 'done',
      usage: { promptTokens: 5, completionTokens: 3 },
      finishReason: 'stop',
    });
  } finally {
    await handle.dispose();
  }
});

test('a worker rejects a download that does not match the record', async () => {
  const model = await createSyntheticModel({ modelId: 'example-org/tiny-fixture' });
  const altered = {
    ...model.record,
    files: model.record.files.map((file, index) =>
      index === 0 ? { ...file, sha256: '0'.repeat(64) } : file,
    ),
  };
  const worker =
    typeof Worker === 'undefined'
      ? nodeWorker(model)
      : new Worker(
          new URL(
            '../../packages/models/test/support/transformers-worker-entry.ts',
            import.meta.url,
          ),
          { type: 'module' },
        );
  // The Worker may download, but a body that does not match the record never reaches the runtime.
  await expect(
    createTransformersEngine({ worker, model: altered, allowDownload: true }, { gpu: undefined }),
  ).rejects.toMatchObject({ code: 'unavailable', reason: 'integrity' });
  if (typeof Worker !== 'undefined') worker.terminate();
});
